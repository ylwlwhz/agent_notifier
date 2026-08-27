/**
 * Cursor CLI 会话 —— 飞书发起、本仓库拥有、可【随时回复】的 Cursor 会话。
 *
 * 与 cursor-hook.js 的分工（两条路并存，不要混）：
 *   cursor-hook.js  管你在 IDE 里手工开的会话。只能旁路观察 + 在 stop 的瞬时窗口续写。
 *   cursor-cli.js   管飞书发起的会话。会话 id 由我们生成保管，`agent -p --resume <id>`
 *                   可在任意时刻推消息进去，所以输入框全程有效、没有超时、不阻塞任何东西。
 *
 * 一轮一张卡：开跑时新发，流式事件到达时 patch 同一张，收尾时定稿并留下输入框。
 * 执行中收到的新指令会排队，本轮结束后自动发出 —— 用户不必等。
 */

'use strict';

const path = require('path');
const cards = require('./cursor-cards');
const {
    newCliSessionId,
    runAgentTurn,
    resolveAgentBin,
} = require('../adapters/cursor/cli-session');

// 卡片 patch 节流：流式事件很密，每条都 patch 会撞飞书频控
const PATCH_INTERVAL_MS = 1500;
// 单个会话最多攒这么多段，防止超长会话把卡片和状态文件撑爆
const MAX_SEGMENTS = 30;

/** 会话记录的 state key —— 稳定不变，所以卡片输入框永远路由到同一个会话 */
function sessionStateKey(cliSessionId) {
    return `cursor_cli_${String(cliSessionId).slice(0, 8)}`;
}

/**
 * 把流式事件增量攒成「助手文字段 + 其后的工具」结构。
 * 与 cursor-live 的 buildSegments 同形，但这里是增量的（边流边渲染）。
 */
function createSegmentAccumulator() {
    const segments = [];
    const byCallId = new Map();
    let current = null;

    const ensureSegment = () => {
        if (!current) {
            current = { text: '', tools: [] };
            segments.push(current);
        }
        return current;
    };

    return {
        segments,
        add(event) {
            if (!event) return;
            if (event.kind === 'text') {
                current = { text: event.text, tools: [] };
                segments.push(current);
                if (segments.length > MAX_SEGMENTS) segments.splice(0, segments.length - MAX_SEGMENTS);
                return;
            }
            if (event.kind === 'tool_started') {
                const step = { tool: event.tool, icon: event.icon, input: event.input, result: '' };
                ensureSegment().tools.push(step);
                if (event.callId) byCallId.set(event.callId, step);
                return;
            }
            if (event.kind === 'tool_completed') {
                const step = event.callId ? byCallId.get(event.callId) : null;
                if (step) {
                    step.result = event.result || '';
                    step.ok = event.ok;
                } else {
                    // 没配上 started（极少见）：补一条，别把这步丢了
                    ensureSegment().tools.push({
                        tool: event.tool, icon: event.icon, input: event.input,
                        result: event.result || '', ok: event.ok,
                    });
                }
            }
        },
    };
}

/** 建立会话记录（还没跑任何一轮） */
async function createSession({ state, workspace, chatId }) {
    const cliSessionId = newCliSessionId();
    const stateKey = sessionStateKey(cliSessionId);
    const record = {
        host: 'cursor',
        notification_type: 'cursor_cli_session',
        session_id: `cursor_${cliSessionId}`,
        cli_session_id: cliSessionId,
        workspace,
        project_name: path.basename(workspace),
        chat_id: chatId,
        // Cursor 没有终端；这条记录靠 cli_session_id 回流，不参与终端注入
        pts_device: null,
        created_at: Date.now(),
        running: false,
        queue: [],
        responses: {},
    };
    await state.addNotificationAsync(stateKey, record);
    return { stateKey, record };
}

/**
 * 收下一条用户指令。
 * 返回 { started } 表示这次由我们开跑，{ queued } 表示当前轮还在跑、已排队。
 *
 * running 标记落在共享 state 里而不是内存里：state 是多进程账本，
 * 内存标记在 listener 重启后就丢了，会导致同一会话被并发跑两轮。
 */
async function acceptPrompt({ state, stateKey, prompt }) {
    let outcome = { started: false, queued: false, missing: false };
    await state.mutateAsync((data) => {
        const record = data[stateKey];
        if (!record) { outcome.missing = true; return false; }
        if (record.running) {
            record.queue = [...(record.queue || []), prompt];
            outcome = { started: false, queued: true, depth: record.queue.length };
        } else {
            record.running = true;
            record.created_at = Date.now(); // 续命，避免长期使用的会话被过期清理掉
            outcome = { started: true, queued: false };
        }
    });
    return outcome;
}

/** 取出排队中的下一条；没有则把 running 置回 false */
async function takeNextPrompt({ state, stateKey }) {
    let next = null;
    await state.mutateAsync((data) => {
        const record = data[stateKey];
        if (!record) return false;
        const queue = record.queue || [];
        if (queue.length) {
            next = queue[0];
            record.queue = queue.slice(1);
            record.running = true;
        } else {
            record.running = false;
        }
    });
    return next;
}

function queueDepth(state, stateKey) {
    const record = state.getNotification(stateKey);
    return (record?.queue || []).length;
}

/**
 * 跑一轮并把卡片从「执行中」推到「已完成」。
 * 结束后自动排空队列（用户在执行中追加的指令会接着跑）。
 */
async function runTurn({ state, client, stateKey, prompt, env = process.env }) {
    const record = state.getNotification(stateKey);
    if (!record) return null;

    const chatId = record.chat_id;
    const accumulator = createSegmentAccumulator();
    let model = null;
    let messageId = null;
    let lastPatch = 0;
    let pendingPatch = false;

    const render = (status, extra = {}) => cards.buildCliTurnCard({
        segments: accumulator.segments,
        status,
        stateKey,
        projectName: record.project_name,
        model,
        queued: queueDepth(state, stateKey),
        ...extra,
    });

    const send = async (card) => {
        const resp = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        return resp?.data?.message_id || null;
    };
    const patch = async (card) => {
        if (!messageId) return;
        await client.im.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(card) },
        });
    };

    try {
        messageId = await send(render('running'));
    } catch (err) {
        console.error('[cursor-cli] 发送执行卡失败:', err.message);
    }

    const onEvent = (event) => {
        if (event.kind === 'init') { model = event.model || model; return; }
        accumulator.add(event);
        if (event.kind === 'result') return; // 结果由收尾统一定稿

        // 节流 patch：流式事件很密，逐条 patch 会撞飞书频控
        const now = Date.now();
        if (pendingPatch || now - lastPatch < PATCH_INTERVAL_MS) return;
        pendingPatch = true;
        lastPatch = now;
        patch(render('running'))
            .catch((err) => console.error('[cursor-cli] patch 失败:', err.message))
            .finally(() => { pendingPatch = false; });
    };

    const outcome = await runAgentTurn({
        sessionId: record.cli_session_id,
        workspace: record.workspace,
        prompt,
        model: env.CURSOR_CLI_MODEL || null,
        force: String(env.CURSOR_CLI_FORCE ?? '1') !== '0',
        env,
        onEvent,
    });

    // 定稿：出错时把错误正文也放进卡里，别让用户只看到一个红标题
    if (outcome.isError && outcome.text) {
        accumulator.add({ kind: 'text', text: `⚠️ ${outcome.text}` });
    }
    const finalCard = render(outcome.isError ? 'error' : 'done', {
        usage: outcome.usage,
        durationMs: outcome.durationMs,
    });
    try {
        if (messageId) await patch(finalCard);
        else messageId = await send(finalCard);
    } catch (err) {
        console.error('[cursor-cli] 定稿卡片失败:', err.message);
    }

    // 排空队列：用户在本轮执行中追加的指令，现在自动接着跑
    const next = await takeNextPrompt({ state, stateKey });
    if (next != null) {
        return runTurn({ state, client, stateKey, prompt: next, env });
    }
    return outcome;
}

/**
 * 对外入口：收一条来自飞书的指令。
 * 已在跑就排队并立刻返回，否则起一轮（不 await，交给后台跑完）。
 */
async function submitPrompt({ state, client, stateKey, prompt, env = process.env }) {
    const accepted = await acceptPrompt({ state, stateKey, prompt });
    if (accepted.missing) return { ok: false, reason: 'missing' };
    if (accepted.queued) return { ok: true, queued: true, depth: accepted.depth };

    const running = runTurn({ state, client, stateKey, prompt, env })
        .catch((err) => {
            console.error('[cursor-cli] 本轮异常:', err.message);
            // 异常也要把 running 放掉，否则这个会话就永久卡住再也收不了指令
            return state.mutateAsync((data) => {
                if (data[stateKey]) data[stateKey].running = false;
            }).catch(() => {});
        });

    return { ok: true, queued: false, running };
}

/** 飞书发起一个新会话：建记录 + 跑首轮 */
async function startSession({ state, client, chatId, workspace, prompt, env = process.env }) {
    const { stateKey } = await createSession({ state, workspace, chatId });
    const result = await submitPrompt({ state, client, stateKey, prompt, env });
    return { stateKey, ...result };
}

module.exports = {
    sessionStateKey,
    createSegmentAccumulator,
    createSession,
    acceptPrompt,
    takeNextPrompt,
    runTurn,
    submitPrompt,
    startSession,
    resolveAgentBin,
    PATCH_INTERVAL_MS,
    MAX_SEGMENTS,
};
