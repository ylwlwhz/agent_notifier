#!/usr/bin/env bash
# 跨平台 statusLine：PS1 风格前缀（user@host:cwd）+ 模型/消耗/上下文 + 套餐限额（5h / 周）。
#
# 由 agent-notifier install.sh 拷贝到 ~/.claude/statusline.sh。
# 不再显示「最近一条 assistant 回复的时间」：Claude Code 自 2.1.24x 起自带这个
# 时间戳（settings 的 showMessageTimestamps / showTurnDuration），状态栏再放一份
# 是重复信息，还要为它逆序读整个 transcript。
# 也不再调 ccusage：它按【自己划的 5 小时块】和自然日聚合，块起点是「首条消息所在整点」，
# 跟 Claude 的额度重置点没关系——限额那行写着「⟳2h11m 后重置」，消耗那行却在报另一个
# 起点的 5 小时，两行对不上。现在第二行的消耗只留「本 5 小时窗口」「本周窗口」两个数，
# 窗口起点由 rate_limits.resets_at 反推，跟第三行严格同一段时间，由 cost-capture.js
# 预先算好塞进 payload（见 src/lib/usage-window.js）；同行的模型与上下文则是 payload
# 里现成的字段，白拿。ccusage 那行的 session / today / block / burn 一并去掉。
# 顺带甩掉了 npx 冷启动拉包导致慢渲染被 Claude 掐掉、状态栏长期冻住的老毛病。
# 设计为 Linux / macOS 通用：只依赖 jq；缺失时静默输出空，绝不污染状态栏
set -u

input=$(cat)

# jq 是硬依赖：缺失则原样退化（输出空行），不报错刷屏
if ! command -v jq >/dev/null 2>&1; then
    printf '\n'
    exit 0
fi

# ── PS1 风格前缀：粗绿 user@host + 冒号 + 粗蓝 cwd，无尾随 $（对齐 shell PS1 观感）──
# cwd 优先取 Claude 传入 JSON payload 的 .cwd 字段，跟着 Claude 实际所在目录走；
# 字段缺失（旧版 payload/解析失败）时退化用 $PWD，不让前缀整体消失。
ps1_cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[[ -z "$ps1_cwd" ]] && ps1_cwd="$PWD"
ps1_user=$(whoami)
ps1_host=$(hostname -s 2>/dev/null || hostname)
ps1_prefix=$(printf '\033[01;32m%s@%s\033[00m:\033[01;34m%s\033[00m' "$ps1_user" "$ps1_host" "$ps1_cwd")

# ── 套餐限额：来自 Claude 传入 payload 的 .rate_limits ──
# used_percentage 是 0-100 的数，resets_at 是 epoch 秒。Claude 2.1.223 的 statusline
# payload 只塞 five_hour 与 seven_day：Fable / Opus / Sonnet 那几档周额度 Claude 自己
# 从响应头（anthropic-ratelimit-unified-7d_oi-* 等）读得到，却没有写进 payload，
# 状态栏这边无从取得。所以这里不写死档位，按 payload 里实际存在的 key 遍历——
# 哪天 Claude 把 Fable 那档也塞进来，不改脚本就会自动多出一段。
# 整个 .rate_limits 缺失（API key 模式、或本次会话还没发出过请求）时整段不出现。
# 重置点显示成「还剩多久」而不是钟点：容器 TZ 是 America/Los_Angeles，和看屏幕的人
# 所在时区经常差着半个地球，钟点每次都要心算；相对时间没有这个问题，也省掉
# GNU/BSD date 的格式差异，只做整数减法。
epoch_to_left() {
    local left=$(( $1 - $(date +%s) ))
    if (( left <= 0 )); then
        printf '0m'
    elif (( left >= 86400 )); then
        printf '%dd%dh' $(( left / 86400 )) $(( left % 86400 / 3600 ))
    elif (( left >= 3600 )); then
        printf '%dh%dm' $(( left / 3600 )) $(( left % 3600 / 60 ))
    else
        printf '%dm' $(( left / 60 ))
    fi
}

limit_label() {
    case "$1" in
        five_hour)                  printf '5h' ;;
        seven_day)                  printf '周' ;;
        seven_day_overage_included) printf 'Fable' ;;
        seven_day_opus)             printf 'Opus' ;;
        seven_day_sonnet)           printf 'Sonnet' ;;
        overage)                    printf '额度' ;;
        *)                          printf '%s' "$1" ;;   # 未知档位原样显示
    esac
}

# 快用完时才需要显眼：≥90 红、≥70 黄，其余绿
limit_color() {
    if [[ "$1" -ge 90 ]]; then
        printf '\033[01;31m'
    elif [[ "$1" -ge 70 ]]; then
        printf '\033[01;33m'
    else
        printf '\033[00;32m'
    fi
}

limits=""
while IFS=$'\t' read -r rl_key rl_pct rl_reset; do
    [[ -z "$rl_key" ]] && continue
    rl_clock=""
    [[ "$rl_reset" != 0 ]] && rl_clock=$(epoch_to_left "$rl_reset")
    limits+="${limits:+ · }$(printf '%s%s %s%%\033[00m%s' \
        "$(limit_color "$rl_pct")" "$(limit_label "$rl_key")" "$rl_pct" "${rl_clock:+ ⟳$rl_clock}")"
done < <(printf '%s' "$input" | jq -r '
    .rate_limits // {}
    | to_entries[]
    | select(.value.used_percentage != null)
    | "\(.key)\t\(.value.used_percentage | round)\t\(.value.resets_at // 0)"' 2>/dev/null)

# ── 第二行：模型 · 各限额窗口的消耗 · 上下文占用 ──
# 模型取 payload 现成的 .model.display_name：Claude 内部已经把型号 id 映射成
# 「Opus 5」这种短标签（binary 里的 us(modelId)），不用自己维护对照表。
# 顺序沿用原来 ccusage 那行的习惯：模型在最前，上下文在最后。
usage=$(printf '%s' "$input" | jq -r '.model.display_name // empty' 2>/dev/null)

# 消耗：限额窗口内的美元花费（全部会话），由 cost-capture.js 预先算好塞进 payload。
# 复用上面的 limit_label：消耗与限额的档位名刻意一模一样，上下对着看就是
# 「这段时间花了多少钱 / 用掉多少额度」。重置时刻只在限额行写一次，这里不重复。
# 字段缺失（cost-capture 没接上、transcript 读不到）时这一段不出现，也不留空位。
while IFS=$'\t' read -r u_key u_cost; do
    [[ -z "$u_key" ]] && continue
    usage+="${usage:+ · }$(printf '%s $%.2f' "$(limit_label "$u_key")" "$u_cost")"
done < <(printf '%s' "$input" | jq -r '
    .agent_notifier.usage // {}
    | to_entries[]
    | select(.value != null)
    | "\(.key)\t\(.value)"' 2>/dev/null)

# 上下文占用：同样是 payload 现成的字段，不扫任何文件。
ctx=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty | round' 2>/dev/null)
[[ -n "$ctx" ]] && usage+="${usage:+ · }$(printf '🧠 %s%%' "$ctx")"

# ── 三行输出：路径、消耗、限额各占一行 ──
# 仓库路径动辄几十列，和后面的内容挤在一行会把它们挤掉（单行渲染是 truncate，
# 不是换行）。Claude 官方渲染器按 \n 拆分：一行时截断显示，多行时改成竖排逐行，
# 并把前几行的 ANSI 序列续到下一行，所以第一行结尾的 reset 不会污染第二行。
# 限额也单独占一行，而不是挂在消耗行尾：挂在行尾的东西在窄于整行宽度的终端上会被
# 整段切掉——「5h 限额不见了」就是这么来的，不是没渲染。
# 逐段拼接而不是固定三个 %s：消耗或限额缺失时不留空行。
out="$ps1_prefix"
[[ -n "$usage" ]] && out+=$'\n'"$usage"
[[ -n "$limits" ]] && out+=$'\n'"$limits"
printf '%s\n' "$out"
