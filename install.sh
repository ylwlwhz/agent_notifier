#!/usr/bin/env bash
#
# ftclaude / ftcodex 专用安装脚本（agent-notifier · 飞书通知链路）
#
# 只安装 ft* 这一套：
#   - 注入 ftclaude() shell 函数（= tclaude + 飞书 hooks，经 pty-relay 中继）
#   - 注入 ftcodex() shell 函数（= tcodex + Codex PTY 中继/实时摘要）
#   - 按当前安装目录校正 feishu-hooks.settings.json 内的 handler 路径
#   - 启动并常驻飞书监听器服务（走公司代理出网）
#
# 刻意不做（与通用版的区别）：
#   - 不写全局 ~/.claude/settings.json（ftclaude 用 `tclaude --settings` 叠加，不污染 claude/tclaude）
#   - 不注入 claude()/codex() 覆盖原命令
#   - 不配 statusLine、不装 claude-remote-shell
#
# 幂等设计：重复运行会先卸载再安装。
#

set -euo pipefail

# ── 颜色定义 ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ── 安装目录 ─────────────────────────────────────────────
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

info()    { echo -e "${BLUE}[信息]${NC} $1"; }
success() { echo -e "${GREEN}[成功]${NC} $1"; }
warn()    { echo -e "${YELLOW}[警告]${NC} $1"; }
error()   { echo -e "${RED}[错误]${NC} $1"; }

# ── 1. 检查依赖 ──────────────────────────────────────────
info "正在检查系统依赖..."

missing=0

if ! command -v node &>/dev/null; then
    error "未找到 node，请先安装 Node.js (https://nodejs.org/)"
    missing=1
else
    success "node $(node --version)"
fi

if ! command -v npm &>/dev/null; then
    error "未找到 npm，请先安装 Node.js (https://nodejs.org/)"
    missing=1
else
    success "npm $(npm --version)"
fi

if ! command -v python3 &>/dev/null; then
    error "未找到 python3，请先安装 Python 3"
    missing=1
else
    success "python3 $(python3 --version 2>&1 | awk '{print $2}')"
fi

if [ "$missing" -eq 1 ]; then
    error "缺少必要依赖，请安装后重新运行此脚本"
    exit 1
fi

# tclaude/tcodex 是 ft* 包装函数的底座，缺失只警告（运行对应命令时才真正需要）
if command -v tclaude &>/dev/null; then
    success "tclaude 可用"
else
    warn "未找到 tclaude —— ftclaude 运行时需要它，请确认 tclaude 已在 PATH 中"
fi

if command -v tcodex &>/dev/null; then
    success "tcodex 可用"
else
    warn "未找到 tcodex —— ftcodex 运行时需要它，请确认 tcodex 已在 PATH 中"
fi

echo ""

# ── 1.5 预清理：先卸载旧配置 ────────────────────────────
if [ -f "$INSTALL_DIR/uninstall.sh" ]; then
    info "正在清理旧配置..."
    bash "$INSTALL_DIR/uninstall.sh" 2>/dev/null || true
    echo ""
    info "旧配置已清理，开始重新安装..."
    echo ""
fi

# ── 2. 安装 npm 依赖 ─────────────────────────────────────
info "正在安装 npm 依赖..."
cd "$INSTALL_DIR"
npm install --no-fund --no-audit 2>&1 | tail -1
success "npm 依赖安装完成"
echo ""

# ── 3. 配置 .env ─────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
    warn ".env 文件已从模板创建，请编辑填入实际配置："
    warn "  $INSTALL_DIR/.env"
    warn "  本机出网需走代理，请确认已设置 http(s)_proxy 与 FEISHU_FORCE_PROXY=1"
    echo ""
else
    success ".env 文件已存在，跳过"
    echo ""
fi

# ── 4. 生成 feishu-hooks.settings.json（按安装目录校正路径）──
# ftclaude 通过 `tclaude --settings <此文件>` 叠加飞书 hooks，只在 ftclaude 时生效，
# 不写全局 ~/.claude/settings.json，也不改动 claude/tclaude 本身。
info "正在生成 feishu-hooks.settings.json（按当前安装目录校正 handler 路径）..."

node -e "
const fs = require('fs');
const dir = '$INSTALL_DIR';
const p = dir + '/feishu-hooks.settings.json';
const hookCmd = 'node ' + dir + '/hook-handler.js';
const liveCmd = 'node ' + dir + '/live-handler.js';
const askCmd  = 'node ' + dir + '/ask-handler.js';

const cfg = {
    hooks: {
        Stop: [
            { hooks: [{ type: 'command', command: hookCmd }] }
        ],
        Notification: [
            { matcher: 'permission_prompt|idle_prompt|elicitation_dialog', hooks: [{ type: 'command', command: hookCmd }] }
        ],
        StopFailure: [
            { hooks: [{ type: 'command', command: hookCmd }] }
        ],
        PostToolUse: [
            { matcher: 'Bash|Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: liveCmd }] }
        ],
        PreToolUse: [
            { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: askCmd }] }
        ]
    }
};

fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
console.log('  + 已写入 ' + p);
"

success "feishu-hooks.settings.json 就绪"
echo ""

# ── 5. 注入 ftclaude() / ftcodex() shell 函数 ──────────────
info "正在配置 ftclaude / ftcodex shell 函数..."

# ftclaude()：
#   - 解析真实 tclaude 二进制（先在子 shell 里去掉 tclaude 的 alias/函数再取路径）
#   - 追加 `--settings <飞书 hooks>` 叠加飞书通知，继承 IS_SANDBOX=1 --dangerously-skip-permissions
#   - 非 tmux 环境经 pty-relay.py 中继，让飞书卡片输入能回注到终端
# ftcodex()：
#   - 解析真实 tcodex 二进制，不覆盖系统 codex/tcodex 命令
#   - 默认把 CODEX_HOME 指向 ~/.tcodex，便于 codex-session-watcher 读取 tcodex session
#   - 经 pty-relay.py 中继，让飞书卡片输入能回注到终端（含 tmux 内运行）
#   - 自动拉起 codex-watcher（若尚未运行），用于解析 Codex 交互提示
AGENT_FUNCS=$(cat <<'EOF'
# ── ftclaude（飞书通知版 tclaude，由 agent-notifier 安装脚本注入） ──
ftclaude() {
    local _ft_settings="__INSTALL_DIR__/feishu-hooks.settings.json"
    local _ft_bin
    _ft_bin="$(unalias tclaude 2>/dev/null; unset -f tclaude 2>/dev/null; command -v tclaude)"
    if [ -z "$_ft_bin" ]; then
        echo "ftclaude: 未找到 tclaude，请先安装 tclaude 或将其加入 PATH" >&2
        return 127
    fi
    if [[ -z "$TMUX" && -z "$PTY_RELAY_ACTIVE" ]]; then
        IS_SANDBOX=1 PTY_RELAY_OUTPUT_PREFIX=claude-pty-output PTY_RELAY_ACTIVE=1 \
            python3 __INSTALL_DIR__/bin/pty-relay.py "$_ft_bin" --dangerously-skip-permissions --settings "$_ft_settings" "$@"
    else
        IS_SANDBOX=1 "$_ft_bin" --dangerously-skip-permissions --settings "$_ft_settings" "$@"
    fi
}
# ── ftclaude 结束 ──

# ── ftcodex（飞书通知版 tcodex，由 agent-notifier 安装脚本注入） ──
_agent_notifier_ensure_codex_watcher() {
    local _an_dir="__INSTALL_DIR__"
    local _an_pid_file="${_an_dir}/codex-watcher.pid"
    local _an_pid
    if [ -f "$_an_pid_file" ]; then
        _an_pid="$(cat "$_an_pid_file" 2>/dev/null || true)"
        if [ -n "$_an_pid" ] && kill -0 "$_an_pid" 2>/dev/null; then
            return 0
        fi
    fi
    if command -v node >/dev/null 2>&1; then
        (
            cd "$_an_dir" || exit 0
            nohup node src/apps/codex-watcher.js >> codex-watcher.log 2>&1 &
            echo $! > "$_an_pid_file"
        ) >/dev/null 2>&1 || true
    fi
}

ftcodex() {
    local _ft_bin
    _ft_bin="$(unalias tcodex 2>/dev/null; unset -f tcodex 2>/dev/null; command -v tcodex)"
    if [ -z "$_ft_bin" ]; then
        echo "ftcodex: 未找到 tcodex，请先安装 tcodex 或将其加入 PATH" >&2
        return 127
    fi
    _agent_notifier_ensure_codex_watcher
    if [[ -z "$PTY_RELAY_ACTIVE" ]]; then
        CODEX_HOME="${CODEX_HOME:-$HOME/.tcodex}" PTY_RELAY_OUTPUT_PREFIX=codex-pty-output PTY_RELAY_ACTIVE=1 \
            python3 __INSTALL_DIR__/bin/pty-relay.py "$_ft_bin" "$@"
    else
        CODEX_HOME="${CODEX_HOME:-$HOME/.tcodex}" "$_ft_bin" "$@"
    fi
}
# ── ftcodex 结束 ──
EOF
)
AGENT_FUNCS=${AGENT_FUNCS//__INSTALL_DIR__/$INSTALL_DIR}

# 幂等注入到指定 rc 文件
sed_inplace() {
    if sed --version >/dev/null 2>&1; then
        sed -i "$@"
    else
        sed -i '' "$@"
    fi
}

remove_existing_agent_funcs() {
    local rc_file="$1"
    sed_inplace '/^# ── ftclaude（飞书通知版 tclaude，由 agent-notifier 安装脚本注入） ──$/,/^# ── ftclaude 结束 ──$/d' "$rc_file"
    sed_inplace '/^# ── ftcodex（飞书通知版 tcodex，由 agent-notifier 安装脚本注入） ──$/,/^# ── ftcodex 结束 ──$/d' "$rc_file"
}

inject_funcs() {
    local rc_file="$1"
    touch "$rc_file"
    if grep -Eq "ftclaude（飞书通知版 tclaude|ftcodex（飞书通知版 tcodex" "$rc_file" 2>/dev/null; then
        remove_existing_agent_funcs "$rc_file"
        printf '\n%s\n' "$AGENT_FUNCS" >> "$rc_file"
        success "已更新 ${rc_file} 中的 ftclaude() / ftcodex() 函数"
    else
        printf '\n%s\n' "$AGENT_FUNCS" >> "$rc_file"
        success "已将 ftclaude() / ftcodex() 函数注入 ${rc_file}"
    fi
}

# zsh：注入 ~/.zshenv（对所有 zsh 都加载，含非交互 login）。
if command -v zsh &>/dev/null || [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zshenv" ]; then
    inject_funcs "$HOME/.zshenv"
fi

# bash：注入 login 文件（.bash_profile 优先，无则 .profile）+ .bashrc 各一份。
if command -v bash &>/dev/null; then
    bash_login_file="$HOME/.bash_profile"
    [ -f "$HOME/.bash_profile" ] || { [ -f "$HOME/.profile" ] && bash_login_file="$HOME/.profile"; }
    inject_funcs "$bash_login_file"
    inject_funcs "$HOME/.bashrc"
fi

warn "请重新打开终端，或 source 对应的 rc 文件使 ftclaude / ftcodex 生效"

echo ""

# ── 6. 配置并启动飞书监听器服务 ──────────────────────────
info "正在配置飞书监听器服务..."

FEISHU_APP_ID=""
if [ -f "$INSTALL_DIR/.env" ]; then
    FEISHU_APP_ID=$(grep -E '^FEISHU_APP_ID=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')
fi

NODE_BIN=$(command -v node)
PLIST_LABEL="com.agent-notifier.feishu-listener"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SYSTEMD_SERVICE="agent-notifier-feishu.service"
SYSTEMD_FILE="$HOME/.config/systemd/user/$SYSTEMD_SERVICE"
CRON_MARKER="# agent-notifier-feishu"

start_service() {
    if [[ "$OSTYPE" == darwin* ]]; then
        # ── macOS: launchd ──
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$PLIST_FILE" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${INSTALL_DIR}/feishu-listener.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/feishu-listener.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/feishu-listener.log</string>
</dict>
</plist>
PLISTEOF
        launchctl bootout "gui/$(id -u)" "$PLIST_FILE" 2>/dev/null || true
        launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
        sleep 1
        if launchctl print "gui/$(id -u)/${PLIST_LABEL}" &>/dev/null; then
            success "飞书监听器已启动（launchd 服务，开机自启）"
        else
            error "飞书监听器启动失败，请检查 $INSTALL_DIR/feishu-listener.log"
        fi
    else
        # ── Linux: 优先 systemd，回退 crontab + nohup ──
        export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

        if systemctl --user is-system-running &>/dev/null 2>&1; then
            # systemd 可用
            mkdir -p "$HOME/.config/systemd/user"
            cat > "$SYSTEMD_FILE" <<SVCEOF
[Unit]
Description=Agent Notifier - Feishu Listener
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/feishu-listener.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
SVCEOF
            systemctl --user daemon-reload
            systemctl --user enable "$SYSTEMD_SERVICE"
            # 开启 lingering：让 user@.service 开机即起、登出也不停，listener 才能真正常驻
            # （否则 --user 服务仅在该用户有登录会话时运行，服务器重启或登出后不会自动拉起）
            if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
                if loginctl enable-linger "$USER" 2>/dev/null; then
                    success "已开启 lingering（开机自启、登出不停）"
                else
                    warn "无法自动开启 lingering，请手动执行: sudo loginctl enable-linger $USER"
                    warn "（否则服务器重启或你登出后，listener 不会自动运行）"
                fi
            fi
            systemctl --user restart "$SYSTEMD_SERVICE"
            sleep 1
            if systemctl --user is-active "$SYSTEMD_SERVICE" &>/dev/null; then
                success "飞书监听器已启动（systemd 服务，开机自启）"
            else
                error "飞书监听器启动失败，请检查: journalctl --user -u $SYSTEMD_SERVICE"
            fi
            info "服务管理："
            echo "  查看状态: systemctl --user status $SYSTEMD_SERVICE"
            echo "  查看日志: journalctl --user -u $SYSTEMD_SERVICE -f"
            echo "  重启服务: systemctl --user restart $SYSTEMD_SERVICE"
        else
            # systemd 不可用，回退到 crontab + nohup
            warn "systemd 用户会话不可用，使用 crontab @reboot 回退方案"
            cd "$INSTALL_DIR"
            nohup "$NODE_BIN" "$INSTALL_DIR/feishu-listener.js" >> "$INSTALL_DIR/feishu-listener.log" 2>&1 &
            echo $! > "$INSTALL_DIR/feishu-listener.pid"
            success "飞书监听器已启动 (PID: $(cat "$INSTALL_DIR/feishu-listener.pid"))"

            # 注册 crontab @reboot（幂等）。crontab 为空时 `crontab -l`/`grep -v` 会返回 1，
            # 在 set -e + pipefail 下会让 install.sh 误退出，所以显式兜底为 true。
            CRON_CMD="@reboot cd $INSTALL_DIR && $NODE_BIN $INSTALL_DIR/feishu-listener.js >> $INSTALL_DIR/feishu-listener.log 2>&1 $CRON_MARKER"
            CRON_TMP="$(mktemp)"
            ( crontab -l 2>/dev/null || true ) | grep -v "$CRON_MARKER" > "$CRON_TMP" || true
            echo "$CRON_CMD" >> "$CRON_TMP"
            crontab "$CRON_TMP"
            rm -f "$CRON_TMP"
            success "已注册 crontab @reboot 开机自启"
        fi
    fi
}

if [ -n "${FEISHU_APP_ID:-}" ] && [ "${FEISHU_APP_ID}" != "your_app_id_here" ]; then
    start_service
else
    warn "未检测到有效的 FEISHU_APP_ID 配置"
    warn "请编辑 .env 后重新运行 install.sh"
fi

echo ""

# ── 7. 完成信息 ──────────────────────────────────────────
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ftclaude / ftcodex 飞书通知安装完成！${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
info "安装目录: $INSTALL_DIR"
info "配置文件: $INSTALL_DIR/.env"
info "飞书 hooks: $INSTALL_DIR/feishu-hooks.settings.json（由 ftclaude --settings 叠加）"
info "Shell 函数: ~/.zshenv（zsh）、~/.bashrc（bash）中的 ftclaude() / ftcodex()"
echo ""
info "后续步骤："
echo "  1. 编辑 .env 填入飞书配置与代理（如尚未配置）"
echo "  2. 重新打开终端，或 source ~/.bashrc（bash）/ ~/.zshenv（zsh）加载 ftclaude / ftcodex"
echo "  3. 运行 ftclaude 启动带飞书通知的 tclaude"
echo "  4. 运行 ftcodex 启动带飞书通知的 tcodex"
echo ""
success "祝使用愉快！"
