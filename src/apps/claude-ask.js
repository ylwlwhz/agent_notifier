'use strict';

/**
 * Claude Code PreToolUse hook handler for AskUserQuestion
 *
 * Receives AskUserQuestion data via stdin and sends interactive Feishu cards
 * so the user can respond from their phone. Supports:
 *   - Single single-select question → orange card with option buttons + text input
 *   - Single multi-select question  → toggle-button card via buildMultiSelectCard
 *   - Multiple questions            → first question card only; listener sends the rest
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');
const { envConfig } = require('../lib/env-config');
const { sessionState } = require('../lib/session-state');
const { resolvePtsDevice } = require('../lib/terminal-inject');
const { buildMultiSelectCard, parseMarkdownToElements } = require('../lib/feishu-card-utils');
const { buildCardFooter } = require('../lib/card-footer');
const { selectCard } = require('../lib/card');
const { isRelayMode, enqueueRequest } = require('../lib/relay');

// ── Utility functions ─────────────────────────────────────

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => { try { done(JSON.parse(data)); } catch { done({}); } });
        setTimeout(() => done({}), 3000).unref();
    });
}

function getProjectName(cwd) {
    if (!cwd) return '';
    try {
        const pkgPath = path.join(cwd, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.name) return pkg.name;
        }
    } catch {}
    return path.basename(cwd);
}

function getTimestamp() {
    return new Date().toLocaleString('zh-CN', {
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

/**
 * Extract contextText from the last assistant message in the transcript.
 * Looks for text blocks preceding the AskUserQuestion tool_use block.
 */
function extractContextText(transcriptPath) {
    if (!transcriptPath) return '';
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let d;
            try { d = JSON.parse(lines[i]); } catch { continue; }
            if (d.type !== 'assistant') continue;
            const content = d.message?.content || [];
            let contextText = '';
            let hasAskUserQuestion = false;
            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    contextText += block.text + '\n';
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                    hasAskUserQuestion = true;
                }
            }
            if (hasAskUserQuestion) {
                return contextText.trim();
            }
            return '';
        }
    } catch {}
    return '';
}

// ── Feishu client ─────────────────────────────────────────

async function getFeishuAppClient() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return null;

    const client = new Lark.Client({ appId, appSecret });

    let chatId = process.env.FEISHU_CHAT_ID;
    if (!chatId) {
        try {
            const resp = await client.im.chat.list({ params: { page_size: 5 } });
            const chats = resp?.data?.items || [];
            if (chats.length === 0) return null;
            chatId = chats[0].chat_id;
        } catch { return null; }
    }

    return { client, chatId };
}

// ── Card senders ──────────────────────────────────────────

/** Case A: single multi-select question.
 *  ctx: { state, containerId } — host service passes its own state + the owning
 *  container id (for docker-exec injection routing); in-container fallback omits
 *  ctx, defaulting to the module singleton state and no container id. */
async function sendMultiSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts, ctx = {}) {
    const state = ctx.state || sessionState;
    const notif = {
        session_id: sessionId,
        notification_type: notificationType,
        pts_device: ptsDevice,
        container_id: ctx.containerId,
        created_at: Date.now(),
        responses: {},
        _multi_select: true,
        _selected: [],
        _ms_options: q.options.map(o => o.label),
        _ms_descriptions: q.options.map(o => o.description || ''),
        _ms_total: q.options.length,
        _question: q.question || '',
        _context_text: q._contextText || '',
        _note_parts: noteParts,
        _message_id: null,
    };

    const card = buildMultiSelectCard(notif, stateKey);

    // 先写 state 再发卡，避免「卡片已可点但通知未落盘」的竞态（误报已过期）。
    // _message_id 只能在发送后才知道，故发完再补写——它仅用于 form 回调不带
    // action.value 时的反查兜底，短暂缺失不影响按钮/输入框的正常路由。
    await state.addNotificationAsync(stateKey, notif);
    try {
        const resp = await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: app.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });
        const messageId = resp?.data?.message_id || null;
        if (messageId) {
            await state.mutateAsync((data) => {
                if (!data[stateKey]) return false; // 已被消费/清理，不复活
                data[stateKey]._message_id = messageId;
            });
        }
    } catch (err) {
        console.error('[ask-handler] 发送多选卡片失败:', err.message);
        await state.removeNotificationAsync(stateKey).catch(() => {});
    }
}

/** Case B: single single-select question */
async function sendSingleSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts, ctx = {}) {
    const state = ctx.state || sessionState;
    const card = selectCard({
        title: q.header || '方案选择',
        contextText: q._contextText || '',
        question: q.question || '',
        options: q.options, // 传完整 {label, description}，卡片在按钮下展示说明
        stateKey, noteParts,
        mdToEls: parseMarkdownToElements,
    });

    // Build responses map — Claude Code TUI 使用箭头键导航，不接受数字选择
    // opt_0 (第一个，默认高亮): 直接 Enter
    // opt_N: N 次 ↓ 再 Enter
    const ARROW_DOWN = '\x1b[B';
    const responses = {};
    q.options.forEach((opt, idx) => {
        responses[`opt_${idx}`] = { keys: ARROW_DOWN.repeat(idx) + '\r', label: opt.label };
    });
    const otherIdx = q.options.length; // Other 是最后一项
    responses['opt_other'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: 'Other' };
    responses['_other_num'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: '_meta' };
    responses['esc'] = { keys: '\x1b', label: 'Esc' };
    responses['interrupt'] = { keys: '\x1b', label: '⛔ Interrupt' };

    // 先写 state 再发卡（见 sendMultiSelectCard 注释：反序会误报「卡片已过期」）
    await state.addNotificationAsync(stateKey, {
        session_id: sessionId,
        notification_type: notificationType,
        pts_device: ptsDevice,
        container_id: ctx.containerId,
        created_at: Date.now(),
        responses,
    });
    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: app.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });
    } catch (err) {
        console.error('[ask-handler] 发送单选卡片失败:', err.message);
        await state.removeNotificationAsync(stateKey).catch(() => {});
    }
}

/** Case C: multiple questions — send first, store all for listener */
async function sendMultiQuestionFirstCard(app, questions, stateKey, ptsDevice, sessionId, notificationType, noteParts, ctx = {}) {
    const state = ctx.state || sessionState;
    const q = questions[0];
    const contextText = q._contextText || '';
    const ARROW_DOWN = '\x1b[B';
    const otherIdx = q.options.length;

    const qResponses = {};
    q.options.forEach((opt, optIdx) => {
        qResponses[`opt_${optIdx}`] = { keys: ARROW_DOWN.repeat(optIdx) + '\r', label: opt.label };
    });
    qResponses['opt_other'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: 'Other' };
    qResponses['_other_num'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: '_meta' };
    qResponses['interrupt'] = { keys: '\x1b', label: '⛔ Interrupt' };

    // Store all questions for listener
    await state.addNotificationAsync(stateKey, {
        session_id: sessionId,
        notification_type: notificationType,
        pts_device: ptsDevice,
        container_id: ctx.containerId,
        created_at: Date.now(),
        responses: qResponses,
        _all_questions: questions,
        _current_q: 0,
        _chat_id: app.chatId,
        _note_parts: noteParts,
    });

    const qCard = selectCard({
        title: `${q.header || '选择'} (1/${questions.length})`,
        contextText,
        question: q.question || '',
        options: q.options, // 传完整 {label, description}
        stateKey, noteParts,
        mdToEls: parseMarkdownToElements,
    });

    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(qCard) },
        });
    } catch (err) {
        console.error('[ask-handler] 发送 Q1 卡片失败:', err.message);
    }
}

// ── Request shaping + host-side dispatch ─────────────────

/**
 * Turn a raw AskUserQuestion hook payload into a self-contained request the host
 * service can act on without touching the container's filesystem. Everything the
 * host needs (pts device, container id, transcript-derived context, project name,
 * state key) is resolved here, in the container, where those live.
 * Returns null if this isn't an AskUserQuestion we should handle.
 */
function buildAskRequestFromHook(data) {
    const questions = data.tool_input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    const sessionId = data.session_id || '';
    return {
        kind: 'ask',
        questions,
        session_id: sessionId,
        context_text: extractContextText(data.transcript_path || ''),
        project_name: getProjectName(data.cwd || ''),
        pts_device: resolvePtsDevice(process.ppid),
        container_id: process.env.AGENT_NOTIFIER_CONTAINER_ID || os.hostname(),
        state_key: `feishu_ask_${sessionId.substring(0, 8)}_${Date.now()}`,
        notification_type: 'AskUserQuestion',
    };
}

/**
 * Build + send the appropriate card(s) for an ask request and store the
 * notification. Shared by the in-container hook (app+state local) and the host
 * service (app = host client, ctx.state = host state; req.container_id routes
 * injection back via docker exec).
 */
async function handleAskRequest(app, req, ctx = {}) {
    const questions = req.questions || [];
    if (!questions.length) return;
    questions.forEach(q => { q._contextText = req.context_text || ''; });

    const footerEl = buildCardFooter({
        host: 'claude',
        ptsDevice: req.pts_device,
        projectName: req.project_name,
    });
    const noteParts = footerEl.content;
    const sctx = { state: ctx.state, containerId: req.container_id };
    const sk = req.state_key;
    const nt = req.notification_type || 'AskUserQuestion';

    if (questions.length > 1) {
        await sendMultiQuestionFirstCard(app, questions, sk, req.pts_device, req.session_id, nt, noteParts, sctx);
    } else if (questions[0].multiSelect) {
        await sendMultiSelectCard(app, questions[0], sk, req.pts_device, req.session_id, nt, noteParts, sctx);
    } else {
        await sendSingleSelectCard(app, questions[0], sk, req.pts_device, req.session_id, nt, noteParts, sctx);
    }
}

// ── Main ─────────────────────────────────────────────────

async function main() {
    const data = await readStdin();

    // 诊断日志
    const logLine = JSON.stringify({
        ts: Date.now(),
        event: data.hook_event_name,
        tool: data.tool_name,
        hasQuestions: Array.isArray(data.tool_input?.questions),
        qCount: data.tool_input?.questions?.length,
        inputType: typeof data.tool_input,
        inputKeys: data.tool_input ? Object.keys(data.tool_input) : null,
    });
    fs.appendFileSync('/tmp/ask-handler-diag.log', logLine + '\n');

    // Guard: only handle PreToolUse / AskUserQuestion
    if (data.hook_event_name !== 'PreToolUse') return;
    if (data.tool_name !== 'AskUserQuestion') return;

    const req = buildAskRequestFromHook(data);
    if (!req) return;

    // Relay mode: hand the fully-resolved request to the host and exit fast.
    // (No Feishu creds needed in the container — the host owns Feishu.)
    if (isRelayMode()) {
        try {
            enqueueRequest(req);
        } catch (err) {
            console.error('[ask-handler] outbox enqueue 失败:', err.message);
        }
        return;
    }

    // In-container fallback: send directly, listener injects locally.
    if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) return;
    const app = await getFeishuAppClient();
    if (!app) return;
    await handleAskRequest(app, req, { state: sessionState });
}

if (require.main === module) {
    main().catch(err => { console.error('[ask-handler]', err.message); process.exit(0); });
}

module.exports = {
    getFeishuAppClient,
    getProjectName,
    getTimestamp,
    sendSingleSelectCard,
    sendMultiSelectCard,
    sendMultiQuestionFirstCard,
    buildAskRequestFromHook,
    handleAskRequest,
    main,
};
