#!/usr/bin/env bash
# 跨平台 statusLine，两行：
#   1) PS1 风格前缀 user@host:cwd
#   2) 模型 · 思考强度 · 各限额档位「消耗 $x  已用 y%  ⟳还有多久重置」· 上下文占用
#
# 由 agent-notifier install.sh 拷贝到 ~/.claude/statusline.sh。
# 不再显示「最近一条 assistant 回复的时间」：Claude Code 自 2.1.24x 起自带这个
# 时间戳（settings 的 showMessageTimestamps / showTurnDuration），状态栏再放一份
# 是重复信息，还要为它逆序读整个 transcript。
# 也不再调 ccusage：它按【自己划的 5 小时块】和自然日聚合，块起点是「首条消息所在整点」，
# 跟 Claude 的额度重置点没关系，报的窗口和 rate_limits 说的根本不是同一段时间——正因为
# 现在两者严格同窗口，才能把消耗和限额并成一段写。消耗由 cost-capture.js 预先算好塞进
# payload（窗口起点由 rate_limits.resets_at 反推，见 src/lib/usage-window.js）；模型、
# 思考强度、上下文都是 payload 里现成的字段，白拿。ccusage 那行的 session / today /
# block / burn 一并去掉，顺带甩掉了 npx 冷启动拉包导致慢渲染被 Claude 掐掉、状态栏
# 长期冻住的老毛病。
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

# ── 限额档位的公共件（供下面的第二行拼装）──
# .rate_limits 里 used_percentage 是 0-100 的数，resets_at 是 epoch 秒。
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

# ── 第二行：模型 · 思考强度 · 各限额窗口（消耗 + 已用 + 重置倒计时）· 上下文占用 ──
# 模型取 payload 现成的 .model.display_name：Claude 内部已经把型号 id 映射成
# 「Opus 5」这种短标签（binary 里的 us(modelId)），不用自己维护对照表。
# 顺序沿用原来 ccusage 那行的习惯：模型在最前，上下文在最后。
usage=$(printf '%s' "$input" | jq -r '.model.display_name // empty' 2>/dev/null)

# 思考强度 .effort.level（low / medium / high / xhigh / max）。
# 它和扩展思考的开关是**两个字段**：Claude 只在「当前模型支持 reasoning effort」时才塞
# effort，而 thinking.enabled 一直都在、且与 effort 互不约束。所以关掉扩展思考时 effort
# 仍可能留着一个值——那种情况下报强度是误导，直接标「思考关」。
effort=$(printf '%s' "$input" | jq -r '
    if .thinking.enabled == false then "思考关" else (.effort.level // empty) end' 2>/dev/null)
[[ -n "$effort" ]] && usage+="${usage:+ · }$effort"

# 每个限额档位一段：「档位 花了多少钱 用掉百分之几 ⟳还有多久重置」。
# 消耗（.agent_notifier.usage，cost-capture.js 预先算好）与限额（.rate_limits）说的是
# 同一个窗口，拆成两行反而要人来回对；合成一段，一眼就是「这 5 小时花了 $20.96、
# 用掉 31%、54 分钟后清零」。
#
# 两边的键都不写死，按 payload 里实际存在的档位遍历——Claude 2.1.223 的 payload 只塞
# five_hour 与 seven_day（Fable / Opus / Sonnet 那几档周额度它自己从响应头读得到却没写
# 进来），哪天补上了，不改脚本就会自动多出一段。取并集而不是只认 rate_limits：整个
# .rate_limits 缺失时（API key 模式、或本次会话还没发出过请求）消耗仍按滚动窗口显示。
# 顺序也在 jq 里定死：先 rate_limits 的原始顺序，再补只有消耗没有限额的档位。
#
# 颜色只包住「档位 + 金额 + 百分比」，倒计时留在染色区外，跟改动前一致。
# 单档缺消耗就不写钱、缺限额就不写百分比和倒计时，不留空位。
#
# ⚠️ 分隔符用 \x1f 而不是 @tsv 的制表符：制表符属于 IFS 空白字符，bash 会把连续的
# 空白分隔符**合并成一个**，于是「有消耗但没限额」这种空字段会被吃掉，后面的列整体
# 前移——百分比栏读到 resets_at、倒计时栏读到金额，epoch_to_left 收到小数直接报
# 「invalid arithmetic operator」。非空白分隔符才会保留空字段。
while IFS=$'\x1f' read -r w_key w_pct w_reset w_cost; do
    [[ -z "$w_key" ]] && continue
    w_seg=$(limit_label "$w_key")
    [[ -n "$w_cost" ]] && w_seg=$(printf '%s $%.2f' "$w_seg" "$w_cost")
    if [[ -n "$w_pct" ]]; then
        w_clock=""
        [[ "$w_reset" != 0 ]] && w_clock=$(epoch_to_left "$w_reset")
        w_seg=$(printf '%s%s %s%%\033[00m%s' \
            "$(limit_color "$w_pct")" "$w_seg" "$w_pct" "${w_clock:+ ⟳$w_clock}")
    fi
    usage+="${usage:+ · }$w_seg"
done < <(printf '%s' "$input" | jq -r '
    . as $p
    | ($p.rate_limits // {}) as $r
    | ($p.agent_notifier.usage // {}) as $u
    | (($r | keys_unsorted) + (($u | keys_unsorted) - ($r | keys_unsorted)))[]
    | . as $k
    | [ $k,
        ($r[$k].used_percentage // null | if . == null then "" else (round | tostring) end),
        ($r[$k].resets_at // 0 | tostring),
        ($u[$k] // null | if . == null then "" else tostring end) ]
    | join("\u001f")' 2>/dev/null)

# 上下文占用：同样是 payload 现成的字段，不扫任何文件。
ctx=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty | round' 2>/dev/null)
[[ -n "$ctx" ]] && usage+="${usage:+ · }$(printf '🧠 %s%%' "$ctx")"

# ── 两行输出：路径一行，其余一行 ──
# 仓库路径动辄几十列，和后面的内容挤在一行会把它们挤掉（单行渲染是 truncate，
# 不是换行）。Claude 官方渲染器按 \n 拆分：一行时截断显示，多行时改成竖排逐行，
# 并把前几行的 ANSI 序列续到下一行，所以第一行结尾的 reset 不会污染第二行。
# 限额曾经因为「挂在行尾被整段切掉」而单独占过一行——那时候第二行是 ccusage 的六段
# 输出，实测 143 显示列，窄一点的终端根本放不下。现在这一整行只有 70 列上下，
# 合回来是安全的；真要再加东西之前，先量一遍显示宽度。
# 逐段拼接而不是固定两个 %s：第二行整体为空时不留空行。
out="$ps1_prefix"
[[ -n "$usage" ]] && out+=$'\n'"$usage"
printf '%s\n' "$out"
