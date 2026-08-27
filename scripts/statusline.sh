#!/usr/bin/env bash
# 跨平台 statusLine：PS1 风格前缀（user@host:cwd）+ ccusage 输出 + 套餐限额（5h / 周）。
#
# 由 agent-notifier install.sh 拷贝到 ~/.claude/statusline.sh。
# 不再显示「最近一条 assistant 回复的时间」：Claude Code 自 2.1.24x 起自带这个
# 时间戳（settings 的 showMessageTimestamps / showTurnDuration），状态栏再放一份
# 是重复信息，还要为它逆序读整个 transcript。
# 设计为 Linux / macOS 通用：
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

# ── 补上 ccusage 内置定价表里缺的 Claude 5 系列 ──
# statusline 子命令默认 --offline，用的是 ccusage 打包进二进制的定价快照；那份快照
# 还没有 claude-opus-5 / claude-sonnet-5，缺价的模型花费被整段算成 0（ccusage 自己
# 会 WARN: "Missing embedded pricing for claude-opus-5"），于是 today / block 只剩
# 零头——实测 $0.32，真实是 $21.33。--no-offline 能算对，但它每次渲染都要现拉
# LiteLLM 的定价 JSON，实测 17 秒且没有磁盘缓存，放进状态栏就是之前那个「慢渲染被
# Claude 杀掉、状态栏冻住」的老毛病。
# 所以走 ccusage 官方的 CCUSAGE_MODEL_ALIASES，把 Claude 5 映射到内置表里费率完全
# 相同的旧型号：Opus 5 与 Opus 4.6 同为 $5/$25，Sonnet 5 与 Sonnet 4.5 同为 $3/$15。
# 实测与 --no-offline 的结果一分不差（$26.23 = $26.23），且仍然零网络（0.02s）。
# 注：Sonnet 5 到 2026-08-31 有 $2/$10 促销价，内置表和 LiteLLM 线上表都没反映，
# 这期间两边都会把 sonnet 那部分算高——不是这里引入的偏差。
# 等某个 ccusage 版本内置了 Claude 5 定价，这行就可以删掉；外部已设则不覆盖。
export CCUSAGE_MODEL_ALIASES="${CCUSAGE_MODEL_ALIASES:-claude-opus-5=claude-opus-4-6,claude-sonnet-5=claude-sonnet-4-5}"

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

# ── 三行输出：路径、用量、限额各占一行 ──
# 仓库路径动辄几十列，和用量挤在一行会把后面的信息挤掉（单行渲染是 truncate，
# 不是换行）。Claude 官方渲染器按 \n 拆分：一行时截断显示，多行时改成竖排逐行，
# 并把前几行的 ANSI 序列续到下一行，所以第一行结尾的 reset 不会污染第二行。
# 限额也单独占一行，而不是挂在用量行尾：ccusage 一行要吐 model / session / today /
# block / burn / context 六段，实测 143 显示列，挂在行尾的限额在任何窄于此的终端上
# 都会被整段切掉——「5h 限额不见了」就是这么来的，不是没渲染。
# 逐段拼接而不是固定三个 %s：ccusage 缺失（无 bun/npx）或限额缺失时不留空行。
out="$ps1_prefix"
[[ -n "$ccusage_out" ]] && out+=$'\n'"$ccusage_out"
[[ -n "$limits" ]] && out+=$'\n'"$limits"
printf '%s\n' "$out"
