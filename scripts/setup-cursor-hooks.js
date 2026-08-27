#!/usr/bin/env node
'use strict';

/**
 * 幂等地把 agent-notifier 的 Cursor hooks 写进 ~/.cursor/hooks.json。
 *
 * 用法:
 *   node scripts/setup-cursor-hooks.js               安装 / 更新
 *   node scripts/setup-cursor-hooks.js --notify-only 只装只读事件（远程机用，见下）
 *   node scripts/setup-cursor-hooks.js --remove      卸载（只删本仓库注入的条目）
 *
 * 环境变量:
 *   AGENT_NOTIFIER_DIR   安装目录（默认取本脚本上一级）
 *   CURSOR_HOOKS         hooks.json 路径（默认 ~/.cursor/hooks.json）
 *
 * 为什么要有 --notify-only：Cursor Remote-SSH 的 agent 运行时整个跑在【远程机】上，
 * hooks 也在那边执行，所以远程会话要收通知就必须把 hook 装到远程机。但审批/续写这两条
 * 是【阻塞】链路，它们要求「发卡的 hook」与「收飞书回调的 listener」能碰到同一份
 * decision-bridge 文件；listener 在本机、hook 在远程，碰不上。此时装上阻塞事件只会
 * 让远程每条命令都白等一次超时，所以远程一律只装只读事件。
 *
 * 为什么装到用户级而不是项目级：用户级对所有项目生效，符合「离开电脑也能收到通知」
 * 的用途；项目级 .cursor/hooks.json 会被提交进别人的仓库，且云端 agent 也会加载它。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const installDir = process.env.AGENT_NOTIFIER_DIR || path.join(__dirname, '..');
const hooksPath = process.env.CURSOR_HOOKS || path.join(os.homedir(), '.cursor', 'hooks.json');
const command = `node ${path.join(installDir, 'cursor-hook-handler.js')}`;

// 本仓库注入条目的识别特征：卸载与幂等判定都靠它
const MARKER = 'cursor-hook-handler.js';

/** 读 .env 里的超时配置，算出 hooks.json 该给多长的 timeout */
function readEnvTimeouts() {
    const envPath = path.join(installDir, '.env');
    const values = {};
    try {
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
            if (m) values[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
        }
    } catch { /* 没有 .env 就用默认值 */ }
    const num = (key, fallback) => {
        const n = parseFloat(process.env[key] ?? values[key]);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    // 与 control-policy 的 truthy 同语义：只认 1/true/yes/on，其余按默认
    const bool = (key, fallback) => {
        const raw = String(process.env[key] ?? values[key] ?? '').trim().toLowerCase();
        if (!raw) return fallback;
        if (['0', 'false', 'no', 'off'].includes(raw)) return false;
        return ['1', 'true', 'yes', 'on', 'all'].includes(raw) ? true : fallback;
    };
    return {
        approvalSec: num('CURSOR_APPROVAL_TIMEOUT_SEC', 180),
        followupSec: num('CURSOR_FOLLOWUP_TIMEOUT_SEC', 300),
        loopLimit: Math.round(num('CURSOR_STOP_LOOP_LIMIT', 50)),
        expireHours: num('NOTIFICATION_EXPIRE_HOURS', 12),
        approvalEnabled: bool('CURSOR_REMOTE_APPROVAL', false),
        followupEnabled: bool('CURSOR_REMOTE_FOLLOWUP', false),
    };
}

/**
 * 等待时长必须短于卡片有效期。否则 listener 的通知过期清理会先把这条通知删掉，
 * 用户在等待窗口内点卡片却被告知「卡片已过期」—— 长等待（数小时级）最容易撞上。
 */
function warnIfWaitOutlivesCard({ approvalSec, followupSec, expireHours }, { approval = true, followup = true } = {}) {
    const expireSec = expireHours * 3600;
    // 只有真的开启了的那条链路才算进「最长等待」——关着的审批不该拉高告警门槛
    const waits = [approval ? approvalSec : 0, followup ? followupSec : 0];
    const longest = Math.max(...waits);
    if (longest < expireSec) return;
    console.warn(
        `  ! 警告：最长等待 ${Math.round(longest / 3600 * 10) / 10}h 已达到/超过卡片有效期 ${expireHours}h。\n` +
        `    等待期内卡片会先被过期清理掉，用户点了会看到「卡片已过期」。\n` +
        `    请把 .env 里的 NOTIFICATION_EXPIRE_HOURS 调到大于最长等待（建议至少 ${Math.ceil(longest / 3600) + 1}）。`
    );
}

/**
 * hooks.json 的 timeout 必须大于我们自己的等待上限，否则 Cursor 会在飞书还没
 * 有人回应时就把 hook 杀掉——用户会看到「点了没反应」而毫无线索。留 30s 余量。
 */
/**
 * 注册哪些事件，由 .env 里的策略决定，而不是一个二元开关。
 *
 * 为什么不能「不带 --notify-only 就一律装全」：阻塞事件即使在策略关闭时也会照样被调用，
 * hook 只是立刻回个空对象——但进程该起还是要起。网络文件系统上那是每条命令 1~2s 的
 * 白付开销（见 docs 里的模块加载实测）。所以审批关着就别注册 beforeShellExecution。
 *
 * notifyOnly 保留为显式覆盖：listener 不在本机时，阻塞链路根本没人接，
 * 无论 .env 怎么写都必须退回只读。
 */
function buildHooksConfig({ notifyOnly = false } = {}) {
    const timeouts = readEnvTimeouts();
    const { approvalSec, followupSec, loopLimit } = timeouts;
    const approvalTimeout = Math.ceil(approvalSec) + 30;
    const followupTimeout = Math.ceil(followupSec) + 30;
    const wantApproval = !notifyOnly && timeouts.approvalEnabled;
    const wantFollowup = !notifyOnly && timeouts.followupEnabled;

    const readOnly = {
        // 会话开始：注入提问形态约定。必须注册——IDE 的交互式选择题是零 hook 事件的
        // 死角，只能在开头引导 agent 别用它（见 adapters/cursor/control-policy）
        sessionStart: { command, timeout: 10 },
        // 只读事件：发完卡就走，给足富裕的短超时
        afterAgentResponse: { command, timeout: 30 },
        postToolUse: { command, timeout: 30, matcher: 'Shell|Write|StrReplace|Edit|Delete|EditNotebook' },
        postToolUseFailure: { command, timeout: 30 },
        // 本仓库不处理它的内容，注册它只为刷「卡死看门狗」的心跳：
        // 大上下文 + 高 effort 的思考可以连续数分钟没有工具调用，没有这条会被误报成卡死。
        // 别当成无用注册删掉（见 cursor-stall-watch 文件头）。
        afterAgentThought: { command, timeout: 10 },
        // 长子代理同理：它是「开始干长活」的信号，缺了会把 Task 期间的沉默误判成卡死
        subagentStart: { command, timeout: 10 },
    };

    const config = { ...readOnly };

    if (wantApproval) {
        // 阻塞审批：hook 返回 permission 决定 Cursor 放不放这条命令 / MCP 调用
        config.beforeShellExecution = { command, timeout: approvalTimeout };
        config.beforeMCPExecution = { command, timeout: approvalTimeout };
    }

    // 阻塞续写：hook 返回 followup_message 就能让 Cursor 自动开下一轮。
    // 不等人时给一次飞书 API 往返的富裕超时就够了，别挂着一个几小时的 timeout。
    config.stop = wantFollowup
        ? { command, timeout: followupTimeout, loop_limit: loopLimit }
        : { command, timeout: 60, loop_limit: loopLimit };

    if (wantApproval || wantFollowup) {
        warnIfWaitOutlivesCard(timeouts, { approval: wantApproval, followup: wantFollowup });
    }
    return config;
}

function loadHooksFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeHooksFile(config) {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + '\n');
}

function install({ notifyOnly = false } = {}) {
    const config = loadHooksFile();
    config.version = config.version || 1;
    if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};

    const desired = buildHooksConfig({ notifyOnly });
    let changed = false;

    for (const [event, definition] of Object.entries(desired)) {
        const list = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
        const idx = list.findIndex((entry) => String(entry?.command || '').includes(MARKER));
        if (idx === -1) {
            list.push(definition);
            changed = true;
            console.log(`  + 添加 Cursor Hook: ${event}`);
        } else if (JSON.stringify(list[idx]) !== JSON.stringify(definition)) {
            // 已存在但参数变了（例如用户改了 .env 里的超时）→ 就地更新，不重复追加
            list[idx] = definition;
            changed = true;
            console.log(`  ~ 更新 Cursor Hook: ${event}`);
        } else {
            console.log(`  - 跳过 Cursor Hook: ${event}（已存在）`);
        }
        config.hooks[event] = list;
    }

    // 从完整模式切到 --notify-only 时，之前注册的阻塞事件必须撤掉。
    // 少了这一步，远程机上会残留 beforeShellExecution，每条命令都白等一次超时。
    for (const event of Object.keys(config.hooks)) {
        if (desired[event]) continue;
        const list = config.hooks[event];
        if (!Array.isArray(list)) continue;
        const kept = list.filter((entry) => !String(entry?.command || '').includes(MARKER));
        if (kept.length === list.length) continue;
        changed = true;
        console.log(`  - 移除 Cursor Hook: ${event}（当前模式不需要）`);
        if (kept.length) config.hooks[event] = kept;
        else delete config.hooks[event];
    }

    if (changed) {
        writeHooksFile(config);
        console.log(`[agent-notifier] Cursor hooks 已写入 ${hooksPath}`
            + (notifyOnly ? '（只读模式：不含审批/续写）' : ''));
    } else {
        console.log('[agent-notifier] Cursor hooks 已是最新');
    }
}

function remove() {
    if (!fs.existsSync(hooksPath)) {
        console.log('[agent-notifier] 未找到 Cursor hooks.json，跳过');
        return;
    }
    const config = loadHooksFile();
    if (!config.hooks || typeof config.hooks !== 'object') return;

    let changed = false;
    for (const [event, list] of Object.entries(config.hooks)) {
        if (!Array.isArray(list)) continue;
        const kept = list.filter((entry) => !String(entry?.command || '').includes(MARKER));
        if (kept.length === list.length) continue;
        changed = true;
        // 只剩空数组就把该事件一并删掉，别在用户配置里留下空壳
        if (kept.length) config.hooks[event] = kept;
        else delete config.hooks[event];
    }

    if (changed) {
        writeHooksFile(config);
        console.log(`[agent-notifier] 已从 ${hooksPath} 移除 Cursor hooks`);
    } else {
        console.log('[agent-notifier] Cursor hooks 未安装，无需移除');
    }
}

if (require.main === module) {
    if (process.argv.includes('--remove')) remove();
    else install({ notifyOnly: process.argv.includes('--notify-only') });
}

module.exports = { buildHooksConfig, readEnvTimeouts, install, remove, hooksPath, MARKER };
