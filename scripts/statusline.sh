#!/usr/bin/env bash
# 跨平台 statusLine：ccusage 输出 + 最近一条 assistant 回复的 HH:MM:SS。
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

if [[ -n "$last_hhmmss" ]]; then
    printf '%s | ⏱ %s\n' "$ccusage_out" "$last_hhmmss"
else
    printf '%s\n' "$ccusage_out"
fi
