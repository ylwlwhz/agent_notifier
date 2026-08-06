#!/usr/bin/env bash
# 跨平台 statusLine：PS1 风格前缀（user@host:cwd）+ ccusage 输出 + 套餐限额
# （5h / 周）+ 最近一条 assistant 回复的 HH:MM:SS。
#
# 由 agent-notifier install.sh 拷贝到 ~/.claude/statusline.sh。
# 设计为 Linux / macOS 通用：
#   - tail -r（BSD）→ 优先 tac（GNU），回退 tail -r
#   - date -j（BSD 解析）→ 平台分支：GNU date -d / BSD date -j
#   - ccusage 优先用已安装的（零网络零冷启动），再回退 bunx || npx || bun x
#   - jq 缺失：静默输出空，绝不污染状态栏
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

transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')

# ── 取 transcript 最后一条 assistant 消息的时间戳 ──
# tail -r（BSD 逆序）在 Linux 不存在 → 优先 GNU 的 tac
reverse_lines() {
    if command -v tac >/dev/null 2>&1; then
        tac
    else
        tail -r
    fi
}

last_iso=""
if [[ -n "$transcript" && -r "$transcript" ]]; then
    last_iso=$(reverse_lines <"$transcript" 2>/dev/null \
        | jq -r 'select(.type=="assistant") | .timestamp' 2>/dev/null \
        | head -1)
fi

# ── ISO8601 → 本地 HH:MM:SS（GNU date 与 BSD date 语法不同）──
iso_to_hhmmss() {
    local iso="$1" clean epoch
    clean=${iso%%.*}   # 去掉 .sssZ 毫秒
    clean=${clean%Z}   # 去掉结尾 Z
    if date --version >/dev/null 2>&1; then
        # GNU date（Linux）：-u -d 解析 UTC，输出本地时间
        epoch=$(date -u -d "${clean}Z" +%s 2>/dev/null) || return 1
        date -d "@$epoch" "+%H:%M:%S" 2>/dev/null
    else
        # BSD date（macOS）：-j -u -f 显式格式
        epoch=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$clean" "+%s" 2>/dev/null) || return 1
        date -r "$epoch" "+%H:%M:%S" 2>/dev/null
    fi
}

last_hhmmss=""
[[ -n "$last_iso" ]] && last_hhmmss=$(iso_to_hhmmss "$last_iso")

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

# ── ccusage：优先已安装的 ccusage 可执行文件——npx 的每容器冷缓存要现场经代理
#    下载整个包，慢渲染会被 Claude 超时杀掉，状态栏就长时间不更新；
#    本地装好的 ccusage 全程无网络。找不到再回退运行器（bunx / npx / bun x）──
run_ccusage() {
    if command -v ccusage >/dev/null 2>&1; then
        ccusage statusline 2>/dev/null
    elif command -v bunx >/dev/null 2>&1; then
        bunx ccusage statusline 2>/dev/null
    elif command -v npx >/dev/null 2>&1; then
        npx -y ccusage statusline 2>/dev/null
    elif command -v bun >/dev/null 2>&1; then
        bun x ccusage statusline 2>/dev/null
    else
        return 1
    fi
}

ccusage_out=$(printf '%s' "$input" | run_ccusage)

# ── 两行输出：路径单占一行 ──
# 仓库路径动辄几十列，和用量挤在一行会把后面的信息挤掉（单行渲染是 truncate，
# 不是换行）。Claude 官方渲染器按 \n 拆分：一行时截断显示，多行时改成竖排逐行，
# 并把前几行的 ANSI 序列续到下一行，所以第一行结尾的 reset 不会污染第二行。
if [[ -n "$last_hhmmss" ]]; then
    printf '%s\n%s%s | ⏱ %s\n' "$ps1_prefix" "$ccusage_out" "${limits:+ | $limits}" "$last_hhmmss"
else
    printf '%s\n%s%s\n' "$ps1_prefix" "$ccusage_out" "${limits:+ | $limits}"
fi
