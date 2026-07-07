'use strict';

/**
 * feishu-host — single host-side owner of ALL Feishu I/O.
 *
 * Runs once on the Docker host (not per container). It:
 *   1. owns the single Feishu WebSocket long-connection. Feishu accepts many
 *      WS connections per app and randomly routes each event to ONE of them,
 *      so any second listener (per-container, old LaunchAgent, other machines)
 *      randomly steals callbacks — globally exactly one connection may exist;
 *   2. drains the shared outbox: in-container hooks drop fully-resolved requests
 *      there, and the host builds/sends every card and stores the notification;
 *   3. on a card callback, runs the normal handleCardAction against host-owned
 *      state, but delegates keystroke injection into the OWNING container via
 *      `docker exec` (see terminal-inject injectViaContainer + inject-keys.js).
 *
 * The host has direct, un-proxied internet, so this also sidesteps the container
 * DNS/EAI_AGAIN flakiness that broke card sends.
 *
 * Env:
 *   FEISHU_APP_ID / FEISHU_APP_SECRET   required (loaded from .env by env-config)
 *   FEISHU_CHAT_ID                      optional; else first chat the bot is in
 *   AGENT_NOTIFIER_STATE                host state file (owned here)
 *   AGENT_NOTIFIER_OUTBOX               shared outbox dir (bind-mounted into containers)
 *   AGENT_NOTIFIER_OUTBOX_POLL_MS       outbox poll interval (default 400)
 */

require('../lib/env-config');
const path = require('path');
const os = require('os');

const { SessionState } = require('../lib/session-state');
const { FeishuListener } = require('./feishu-listener');
const { watch, outboxDir } = require('../lib/outbox');
const { handleAskRequest } = require('./claude-ask');

// 全部日志加时间戳：无时间戳的日志无法与飞书回调的 create_time 对时，
// 已多次拖慢线上诊断（僵尸连接窗口、过期清理时刻等都要靠对时定位）。
for (const m of ['log', 'error', 'warn']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => orig(new Date().toISOString(), ...a);
}

const LOG = (...a) => console.log('[feishu-host]', ...a);

function resolveOutboxDir() {
    // outboxDir() reads AGENT_NOTIFIER_OUTBOX; if unset it defaults to the
    // in-container path, which is wrong on the host — require it explicitly.
    if (process.env.AGENT_NOTIFIER_OUTBOX) return process.env.AGENT_NOTIFIER_OUTBOX;
    // Fallback: repo-local .runtime dir (agent-notifier/src/apps → repo root).
    return path.join(__dirname, '..', '..', '..', '.runtime', 'notifier', 'outbox');
}

async function main() {
    if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
        console.error('[feishu-host] 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，退出');
        process.exit(1);
    }

    // Host-owned state (never shared with containers; the host is the sole owner).
    const state = new SessionState(process.env.AGENT_NOTIFIER_STATE);

    // Map every notification to a docker-exec injection target for its container.
    // pts_device stays clean for display/state; only the injection target wraps.
    const injectTargetFor = (n) => {
        if (!n || !n.pts_device) return n && n.pts_device;
        return n.container_id ? `exec@${n.container_id}@${n.pts_device}` : n.pts_device;
    };

    const listener = new FeishuListener({ state, injectTargetFor });
    process.on('SIGINT', () => { listener.stop(); process.exit(0); });
    process.on('SIGTERM', () => { listener.stop(); process.exit(0); });
    listener.start(); // owns the WebSocket + card.action.trigger handling

    // Resolve the chat once for outbound cards from the outbox.
    let chatId = process.env.FEISHU_CHAT_ID || null;
    if (!chatId) {
        try { chatId = await listener.resolveChatId(); } catch { chatId = null; }
    }
    const app = { client: listener.client, chatId };
    const ctx = { state };

    const dir = resolveOutboxDir();
    LOG(`host owns Feishu; state=${process.env.AGENT_NOTIFIER_STATE || '(default)'} outbox=${dir} chat=${chatId || '(unresolved)'} host=${os.hostname()}`);

    // Send a pre-built card (from claude-hook: Stop / permission / interactive)
    // and store its notification under host state, tagged with container_id so
    // the callback injects into the right container.
    async function handleSendCard(req) {
        if (!app.chatId) throw new Error('send_card: chatId unresolved');
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(req.card) },
        });
        await state.addNotificationAsync(req.state_key, { ...req.notification, created_at: Date.now() });
    }

    // Dispatch table by request kind.
    const dispatchers = {
        ask: (req) => handleAskRequest(app, req, ctx),
        send_card: (req) => handleSendCard(req),
    };

    const intervalMs = parseInt(process.env.AGENT_NOTIFIER_OUTBOX_POLL_MS || '400', 10);
    watch(dir, async (req) => {
        // Late chat resolution if the bot wasn't in a chat at startup.
        if (!app.chatId) {
            try { app.chatId = process.env.FEISHU_CHAT_ID || await listener.resolveChatId(); } catch {}
        }
        const fn = dispatchers[req && req.kind];
        if (!fn) { LOG(`忽略未知请求 kind=${req && req.kind}`); return; }
        LOG(`处理请求 kind=${req.kind} container=${req.container_id} pts=${req.pts_device} key=${req.state_key}`);
        await fn(req);
    }, { intervalMs });

    LOG('outbox watcher 已启动');
}

if (require.main === module) {
    main().catch((err) => { console.error('[feishu-host]', err && err.message); process.exit(1); });
}

module.exports = { main, resolveOutboxDir };
