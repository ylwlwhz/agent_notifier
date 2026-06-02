#!/usr/bin/env bash
#
# Claude/Codex CLI 通知系统 - 一键安装脚本
# 幂等设计：重复运行不会重复注入
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

# ── 平台与包管理器探测（用于"缺失依赖"提示）──────────────
OS="$(uname -s)"
detect_pkg_hint() {
    # $1 = 通用包名；按平台给出安装命令提示
    local pkg="$1"
    if [[ "$OS" == Darwin ]]; then
        echo "brew install $pkg"
    elif command -v apt-get &>/dev/null; then
        echo "sudo apt-get install -y $pkg"
    elif command -v dnf &>/dev/null; then
        echo "sudo dnf install -y $pkg"
    elif command -v yum &>/dev/null; then
        echo "sudo yum install -y $pkg"
    elif command -v pacman &>/dev/null; then
        echo "sudo pacman -S $pkg"
    elif command -v zypper &>/dev/null; then
        echo "sudo zypper install $pkg"
    else
        echo "（请用系统包管理器安装 $pkg）"
    fi
}

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

# ── 1.2 增强依赖检测（缺失只警告 + 给安装命令，不中断）──────
# jq：statusLine 脚本需要；bun/npx：跑 ccusage 需要；mutagen：claude-remote-shell 需要
info "正在检查增强依赖（statusLine / ccusage / claude-remote-shell）..."

if command -v jq &>/dev/null; then
    success "jq $(jq --version 2>&1)"
else
    warn "未找到 jq（statusLine 时间戳解析需要）。安装：$(detect_pkg_hint jq)"
fi

if command -v bun &>/dev/null; then
    success "bun $(bun --version 2>&1)"
elif command -v bunx &>/dev/null; then
    success "bunx 可用"
elif command -v npx &>/dev/null; then
    success "npx 可用（将用 npx 运行 ccusage）"
else
    warn "未找到 bun/bunx/npx（statusLine 的 ccusage 需要其一）。建议安装 bun：curl -fsSL https://bun.sh/install | bash"
fi

if command -v mutagen &>/dev/null; then
    success "mutagen $(mutagen version 2>&1 | head -1)"
else
    if [[ "$OS" == Darwin ]]; then
        warn "未找到 mutagen（claude-remote-shell 远程同步需要）。安装：brew install mutagen-io/mutagen/mutagen"
    else
        warn "未找到 mutagen（claude-remote-shell 远程同步需要）。安装见：https://github.com/mutagen-io/mutagen/releases"
    fi
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
    echo ""
else
    success ".env 文件已存在，跳过"
    echo ""
fi

# ── 4. 配置 Claude Code Hooks ────────────────────────────
info "正在配置 Claude Code Hooks..."

SETTINGS_FILE="$HOME/.claude/settings.json"

# 确保 ~/.claude 目录存在
mkdir -p "$HOME/.claude"

# 如果 settings.json 不存在则创建空 JSON
if [ ! -f "$SETTINGS_FILE" ]; then
    echo '{}' > "$SETTINGS_FILE"
    info "已创建 $SETTINGS_FILE"
fi

# 用 node 内联脚本合并 hooks 配置（幂等：已有相同 hook 则跳过）
node -e "
const fs = require('fs');
const settingsPath = '$SETTINGS_FILE';
const installDir = '$INSTALL_DIR';
const hookCommand = 'node ' + installDir + '/hook-handler.js';
const liveCommand = 'node ' + installDir + '/live-handler.js';
const askCommand = 'node ' + installDir + '/ask-handler.js';

let settings;
try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
    settings = {};
}

if (!settings.hooks) settings.hooks = {};

const hooksConfig = {
    'Stop': [
        {
            hooks: [{ type: 'command', command: hookCommand }]
        }
    ],
    'Notification': [
        {
            matcher: 'permission_prompt|idle_prompt|elicitation_dialog',
            hooks: [{ type: 'command', command: hookCommand }]
        }
    ],
    'StopFailure': [
        {
            hooks: [{ type: 'command', command: hookCommand }]
        }
    ],
    'PostToolUse': [
        {
            matcher: 'Bash|Write|Edit|NotebookEdit',
            hooks: [{ type: 'command', command: liveCommand }]
        }
    ],
    'PreToolUse': [
        {
            matcher: 'AskUserQuestion',
            hooks: [{ type: 'command', command: askCommand }]
        }
    ]
};

let changed = false;

for (const [event, newRules] of Object.entries(hooksConfig)) {
    if (!settings.hooks[event]) {
        settings.hooks[event] = newRules;
        changed = true;
        console.log('  + 添加 Hook: ' + event);
        continue;
    }

    // 检查是否已有相同 command 的 hook
    const existing = settings.hooks[event];
    const targetCmd = event === 'PostToolUse' ? liveCommand : event === 'PreToolUse' ? askCommand : hookCommand;
    const hasHook = existing.some(rule =>
        rule.hooks && rule.hooks.some(h => h.command === targetCmd)
    );

    if (!hasHook) {
        // 追加到已有的 hook 列表
        settings.hooks[event].push(...newRules);
        changed = true;
        console.log('  + 添加 Hook: ' + event);
    } else {
        console.log('  - 跳过 Hook: ' + event + '（已存在）');
    }
}

if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}
"

success "Claude Code Hooks 配置完成"
echo ""

# ── 4.5 配置 statusLine（cost-capture + 跨平台 statusline.sh）──
info "正在配置 statusLine..."

STATUSLINE_SRC="$INSTALL_DIR/scripts/statusline.sh"
STATUSLINE_DST="$HOME/.claude/statusline.sh"

if [ ! -f "$STATUSLINE_SRC" ]; then
    warn "未找到 $STATUSLINE_SRC，跳过 statusLine 配置"
else
    # 拷贝 statusline.sh（若用户已有且不同则备份）
    if [ -f "$STATUSLINE_DST" ] && ! cmp -s "$STATUSLINE_SRC" "$STATUSLINE_DST"; then
        cp "$STATUSLINE_DST" "${STATUSLINE_DST}.bak.$(date +%s 2>/dev/null || echo bak)"
        warn "已备份原 statusline.sh 为 ${STATUSLINE_DST}.bak.*"
    fi
    cp "$STATUSLINE_SRC" "$STATUSLINE_DST"
    chmod +x "$STATUSLINE_DST"

    # 把 statusLine.command 接成：cost-capture.js（旁路抓官方成本）| statusline.sh
    # 幂等：已是该命令则跳过；用户有自定义 statusLine 则备份 settings 并提示，不静默覆盖
    STATUSLINE_CMD="node $INSTALL_DIR/src/apps/cost-capture.js | $STATUSLINE_DST"
    node -e "
const fs = require('fs');
const p = '$SETTINGS_FILE';
const want = '$STATUSLINE_CMD';
let s;
try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { s = {}; }
const cur = s.statusLine && s.statusLine.command;
if (cur === want) { console.log('  - statusLine 已配置，跳过'); process.exit(0); }
if (s.statusLine && cur && !cur.includes('cost-capture.js') && !cur.includes('$STATUSLINE_DST')) {
    fs.writeFileSync(p + '.bak', JSON.stringify(s, null, 2) + '\n');
    console.log('  ! 检测到自定义 statusLine，已备份 settings.json.bak 后覆盖');
}
s.statusLine = { type: 'command', command: want, padding: 0 };
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
console.log('  + statusLine 已接入 cost-capture + statusline.sh');
"
    success "statusLine 配置完成"
fi
echo ""

# ── 5. 注入 shell 函数 ───────────────────────────────────
info "正在配置 shell 函数..."

# claude()/codex() 函数内容
# 用 `type -P`（bash/zsh 通用，只查 PATH 可执行、跳过同名函数）解析真二进制，
# 避免在 wrapper 内用 `command -v` 误拿到函数自身导致递归。
AGENT_FUNCS=$(cat <<'EOF'
# ── Claude Code PTY 中继（由 claude-notifier 安装脚本注入） ──
claude() {
    if [[ -z "$TMUX" && -z "$PTY_RELAY_ACTIVE" ]]; then
        PTY_RELAY_ACTIVE=1 python3 __INSTALL_DIR__/bin/pty-relay.py "$(type -P claude)" "$@"
    else
        command claude "$@"
    fi
}
# ── Claude Code PTY 中继结束 ──

# ── Codex CLI PTY 中继（由 claude-notifier 安装脚本注入） ──
codex() {
    local CODEX_BIN_CMD="${CODEX_BIN:-codex}"
    if [[ -z "$TMUX" && -z "$PTY_RELAY_ACTIVE" ]]; then
        PTY_RELAY_ACTIVE=1 python3 __INSTALL_DIR__/bin/pty-relay.py "$(type -P "$CODEX_BIN_CMD")" "$@"
    else
        command "$CODEX_BIN_CMD" "$@"
    fi
}
# ── Codex CLI PTY 中继结束 ──
EOF
)
AGENT_FUNCS=${AGENT_FUNCS//__INSTALL_DIR__/$INSTALL_DIR}

# 幂等注入到指定 rc 文件
inject_funcs() {
    local rc_file="$1"
    if grep -q "Claude Code PTY 中继" "$rc_file" 2>/dev/null && grep -q "Codex CLI PTY 中继" "$rc_file" 2>/dev/null; then
        success "shell 函数已存在于 ${rc_file}，跳过"
    else
        touch "$rc_file"
        printf '\n%s\n' "$AGENT_FUNCS" >> "$rc_file"
        success "已将 claude()/codex() 函数注入 ${rc_file}"
    fi
}

# zsh：注入 ~/.zshenv 而非 ~/.zshrc。
#   .zshenv 对所有 zsh 都加载（含 login 非交互），claude-remote-shell 的
#   `zsh -l -c "exec claude ..."` 才能解析到函数、拉起 pty-relay；
#   .zshrc 仅交互式加载，非交互路径会漏掉。
if command -v zsh &>/dev/null || [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zshenv" ]; then
    inject_funcs "$HOME/.zshenv"
fi

# bash：注入 ~/.bashrc，并确保 login shell 也加载它。
#   bash 的 login shell 默认只读 .bash_profile/.profile，不读 .bashrc；
#   claude-remote-shell 用 `bash -l -c` 时需 .bash_profile source .bashrc，
#   否则函数在非交互 login 下同样缺失。
if command -v bash &>/dev/null; then
    inject_funcs "$HOME/.bashrc"

    # 确保某个 login 启动文件 source 了 .bashrc（幂等）
    bash_login_file="$HOME/.bash_profile"
    [ -f "$HOME/.bash_profile" ] || { [ -f "$HOME/.profile" ] && bash_login_file="$HOME/.profile"; }
    if ! grep -qsE '(\.|source)[[:space:]]+.*\.bashrc' "$bash_login_file" 2>/dev/null; then
        touch "$bash_login_file"
        printf '\n# 由 claude-notifier 注入：login shell 也加载 .bashrc（remote-shell 非交互兼容）\n[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n' >> "$bash_login_file"
        success "已确保 ${bash_login_file} 加载 .bashrc"
    fi
fi

warn "请重新打开终端，或 source 对应的 rc 文件使其生效"

echo ""

# ── 5.5 安装 claude-remote-shell（可选能力，总是尝试安装）──
# 本体是单个 bash 脚本；macOS 若已 brew 安装则跳过。依赖的 mutagen 不自动装（见上方提示）。
info "正在配置 claude-remote-shell..."

CRS_VERSION="v0.1.4"
CRS_URL="https://raw.githubusercontent.com/torarnv/claude-remote-shell/${CRS_VERSION}/claude-remote-shell"
CRS_BIN="$HOME/.local/bin/claude-remote-shell"

if command -v claude-remote-shell &>/dev/null; then
    success "claude-remote-shell 已安装（$(command -v claude-remote-shell)），跳过"
else
    mkdir -p "$HOME/.local/bin"
    if command -v curl &>/dev/null; then
        if curl -fsSL --connect-timeout 10 --max-time 60 "$CRS_URL" -o "$CRS_BIN" 2>/dev/null && [ -s "$CRS_BIN" ]; then
            chmod +x "$CRS_BIN"
            ln -sf "$CRS_BIN" "$HOME/.local/bin/claude-remote-shell-yolo"
            success "claude-remote-shell ${CRS_VERSION} 已安装到 $CRS_BIN"
            case ":$PATH:" in
                *":$HOME/.local/bin:"*) ;;
                *) warn "请确保 \$HOME/.local/bin 在 PATH 中（可加入 rc 文件）" ;;
            esac
            command -v mutagen &>/dev/null || warn "claude-remote-shell 需要 mutagen 才能运行（见上方安装提示）"
        else
            rm -f "$CRS_BIN"
            warn "claude-remote-shell 下载失败（网络或 tag 变动），跳过。手动安装见 https://github.com/torarnv/claude-remote-shell"
        fi
    else
        warn "未找到 curl，无法自动安装 claude-remote-shell。手动安装见 https://github.com/torarnv/claude-remote-shell"
    fi
fi
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

            # 注册 crontab @reboot（幂等）
            CRON_CMD="@reboot cd $INSTALL_DIR && $NODE_BIN $INSTALL_DIR/feishu-listener.js >> $INSTALL_DIR/feishu-listener.log 2>&1 $CRON_MARKER"
            ( crontab -l 2>/dev/null | grep -v "$CRON_MARKER"; echo "$CRON_CMD" ) | crontab -
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
echo -e "${GREEN}  Claude/Codex CLI 通知系统安装完成！${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
echo ""
info "安装目录: $INSTALL_DIR"
info "配置文件: $INSTALL_DIR/.env"
info "Hooks 配置: $SETTINGS_FILE"
info "Shell 函数: ~/.zshenv（zsh）、~/.bashrc（bash）"
echo ""
info "后续步骤："
echo "  1. 编辑 .env 填入飞书配置（如尚未配置）"
echo "  2. 重新打开终端，或 source ~/.zshenv（zsh）/ ~/.bashrc（bash）加载函数"
echo "  3. 使用 codex() 包装函数时，可通过 CODEX_BIN 指定可执行名"
echo ""
success "祝使用愉快！"
