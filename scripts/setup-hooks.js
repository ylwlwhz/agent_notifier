'use strict';

/**
 * Idempotently wire agent-notifier's Claude Code hooks (and statusLine) into
 * settings.json. Container-friendly port of the inline node logic in install.sh.
 *
 * Env:
 *   AGENT_NOTIFIER_DIR   install dir (default: directory two levels up)
 *   CLAUDE_SETTINGS      settings.json path (default: ~/.claude/settings.json)
 *   AGENT_NOTIFIER_STATUSLINE=0   skip statusLine wiring
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const installDir = process.env.AGENT_NOTIFIER_DIR || path.join(__dirname, '..');
const settingsPath =
    process.env.CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

let settings = {};
try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
} catch {
    settings = {};
}
if (!settings.hooks) settings.hooks = {};

const hookCommand = `node ${installDir}/hook-handler.js`;
const liveCommand = `node ${installDir}/live-handler.js`;
const askCommand = `node ${installDir}/ask-handler.js`;

const hooksConfig = {
    Stop: [{ hooks: [{ type: 'command', command: hookCommand }] }],
    Notification: [
        {
            matcher: 'permission_prompt|idle_prompt|elicitation_dialog',
            hooks: [{ type: 'command', command: hookCommand }],
        },
    ],
    StopFailure: [{ hooks: [{ type: 'command', command: hookCommand }] }],
    PostToolUse: [
        {
            matcher: 'Bash|Write|Edit|NotebookEdit',
            hooks: [{ type: 'command', command: liveCommand }],
        },
    ],
    PreToolUse: [
        {
            matcher: 'AskUserQuestion',
            hooks: [{ type: 'command', command: askCommand }],
        },
    ],
};

let changed = false;
for (const [event, newRules] of Object.entries(hooksConfig)) {
    if (!settings.hooks[event]) {
        settings.hooks[event] = newRules;
        changed = true;
        continue;
    }
    const targetCmd =
        event === 'PostToolUse' ? liveCommand : event === 'PreToolUse' ? askCommand : hookCommand;
    const has = settings.hooks[event].some(
        (rule) => rule.hooks && rule.hooks.some((h) => h.command === targetCmd)
    );
    if (!has) {
        settings.hooks[event].push(...newRules);
        changed = true;
    }
}

// statusLine: cost-capture (sidecar that feeds official cost into completion cards) | statusline.sh
if (process.env.AGENT_NOTIFIER_STATUSLINE !== '0') {
    const statuslineDst = path.join(os.homedir(), '.claude', 'statusline.sh');
    if (fs.existsSync(statuslineDst)) {
        const want = `node ${installDir}/src/apps/cost-capture.js | ${statuslineDst}`;
        // refreshInterval：官方选项，「除事件驱动更新外，每 N 秒重跑一次状态栏命令」。
        // 没有它，状态栏只在会话事件时重渲染：空闲窗口里 ccusage 用量、套餐限额和
        // 重置倒计时会一直停在旧值，直到你敲下一个键。
        const wantRefresh = 30;
        const cur = (settings.statusLine && typeof settings.statusLine === 'object')
            ? settings.statusLine
            : {};
        if (cur.command !== want || cur.refreshInterval !== wantRefresh) {
            settings.statusLine = {
                type: 'command',
                command: want,
                padding: 0,
                refreshInterval: wantRefresh,
            };
            changed = true;
        }
    }
}

if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('[agent-notifier] hooks/statusLine configured in ' + settingsPath);
} else {
    console.log('[agent-notifier] hooks already configured');
}
