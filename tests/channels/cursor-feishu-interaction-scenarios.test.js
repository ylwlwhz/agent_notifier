'use strict';

/**
 * Cursor 远程控制端到端：飞书卡片点击 → decision-bridge → 正阻塞的 hook 进程拿到裁决。
 *
 * 与 Claude/Codex 的场景测试不同，这里【没有终端注入】——Cursor 的 hook 本身就是
 * 那个在等结果的人，所以断言的是「hook 拿到了什么裁决」，而不是「注入了什么按键」。
 *
 * 必须在 require 之前改环境变量：session-state / decision-bridge 都在模块加载时
 * 就按 env 定好了路径的单例。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-e2e-'));
process.env.AGENT_NOTIFIER_STATE = path.join(TMP, 'session-state.json');
process.env.AGENT_NOTIFIER_DECISIONS = path.join(TMP, 'decisions');

const test = require('node:test');
const assert = require('node:assert/strict');

const { sessionState } = require('../../src/lib/session-state');
const { decisionBridge } = require('../../src/lib/decision-bridge');
const { translateCursorHook } = require('../../src/adapters/cursor/hook-adapter');
const cursorHook = require('../../src/apps/cursor-hook');
const cards = require('../../src/apps/cursor-cards');
const { FeishuListener } = require('../../src/apps/feishu-listener');

const shellFixture = require('../fixtures/cursor/before-shell-execution.json');
const stopFixture = require('../fixtures/cursor/stop.json');

/** 假飞书 client：记录发出的卡片与 patch，返回可预测的 message_id */
function fakeApp() {
    const sent = [];
    const patched = [];
    return {
        sent,
        patched,
        chatId: 'chat-x',
        client: {
            im: {
                message: {
                    create: async ({ data }) => {
                        sent.push(JSON.parse(data.content));
                        return { data: { message_id: `m${sent.length}` } };
                    },
                    patch: async ({ path: p, data }) => {
                        patched.push({ messageId: p.message_id, card: JSON.parse(data.content) });
                        return {};
                    },
                },
            },
        },
    };
}

/** 只借 FeishuListener 的方法，不跑它的构造函数（构造函数要求飞书凭证） */
function fakeListener(sentCards) {
    const listener = Object.create(FeishuListener.prototype);
    listener.state = sessionState;
    listener.decisions = decisionBridge;
    listener.sleep = () => Promise.resolve();
    listener.client = {
        im: {
            message: {
                create: async ({ data }) => {
                    sentCards.push(JSON.parse(data.content));
                    return { data: { message_id: 'ack' } };
                },
            },
        },
    };
    return listener;
}

/** 从卡片里翻出交互组件携带的 session_state_key */
function stateKeyOf(card) {
    const found = [];
    const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        if (node.value?.session_state_key) found.push(node.value.session_state_key);
        Object.values(node).forEach(walk);
    };
    walk(card.body.elements);
    return found[0];
}

/** 等到 hook 把待决策请求登记好（askFeishu 是异步的，发卡在 await 之后） */
async function waitForCard(app) {
    for (let i = 0; i < 100 && !app.sent.length; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(app.sent.length, '审批卡应已发出');
    return app.sent[0];
}

/**
 * 跑一遍完整回环：hook 发卡并阻塞 → 模拟用户在飞书上操作 → hook 拿到裁决。
 * 返回 hook 侧真正会回给 Cursor 的东西。
 */
async function roundTrip({ event, buildCard, buildSettled, responses, textResponse, action, timeoutMs = 4000 }) {
    const app = fakeApp();
    const ackCards = [];
    const listener = fakeListener(ackCards);

    const pending = cursorHook.askFeishu({
        event,
        app,
        timeoutMs,
        responses,
        textResponse,
        notificationType: 'cursor_test',
        buildCard,
        buildSettled,
    });

    const card = await waitForCard(app);
    const stateKey = stateKeyOf(card);
    assert.ok(stateKey, '卡片交互组件必须带 session_state_key');

    const toast = await FeishuListener.prototype.handleCardAction.call(listener, {
        action: { ...action, value: { ...action.value, session_state_key: stateKey } },
        context: { open_chat_id: 'chat-x' },
    });
    if (listener._lastInjection) await listener._lastInjection;

    const decision = await pending;
    return { decision, toast, card, ackCards, app, stateKey };
}

// ── 审批链路 ────────────────────────────────────────────────────────────────

test('点「允许」→ hook 收到 permission:allow，卡片收敛为已处理', async () => {
    const event = translateCursorHook(shellFixture);
    const { decision, toast, app, ackCards } = await roundTrip({
        event,
        responses: cards.approvalResponses(),
        textResponse: { field: 'agent_message', extra: { permission: 'deny' } },
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 4000 }),
        action: { tag: 'button', value: { action_type: 'allow' } },
    });

    assert.deepEqual(decision, { permission: 'allow' });
    assert.equal(toast, '已收到');

    assert.equal(app.patched.length, 1, '拿到裁决后应把原卡收敛');
    assert.match(JSON.stringify(app.patched[0].card), /已允许/);
    assert.equal(app.patched[0].card.header.template, 'green');

    assert.equal(ackCards.length, 1, '应另发一张「已收到」卡');
    assert.ok(ackCards[0].header.text_tag_list.some((t) => t.text.content === 'Cursor'),
        '「已收到」卡必须带 Cursor 宿主标签');
});

test('点「拒绝」→ hook 收到 deny，并把给 agent 的说明一起带回', async () => {
    const event = translateCursorHook(shellFixture);
    const { decision } = await roundTrip({
        event,
        responses: cards.approvalResponses(),
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 4000 }),
        action: { tag: 'button', value: { action_type: 'deny' } },
    });

    assert.equal(decision.permission, 'deny');
    assert.match(decision.agent_message, /拒绝/);
});

test('输入框写理由 → 变成「拒绝 + 理由」，理由直达 agent', async () => {
    const event = translateCursorHook(shellFixture);
    const { decision } = await roundTrip({
        event,
        responses: cards.approvalResponses(),
        textResponse: { field: 'agent_message', extra: { permission: 'deny' } },
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 4000 }),
        action: { tag: 'input', input_value: '这台机器不许 deploy', value: { action_type: 'text_input' } },
    });

    assert.deepEqual(decision, {
        permission: 'deny',
        agent_message: '这台机器不许 deploy',
    });
});

test('点「本地确认」→ 回 permission:ask 交回 IDE，且不发「已收到」卡', async () => {
    const event = translateCursorHook(shellFixture);
    const { decision, ackCards } = await roundTrip({
        event,
        responses: cards.approvalResponses(),
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 4000 }),
        action: { tag: 'button', value: { action_type: 'local' } },
    });

    assert.equal(decision.permission, 'ask');
    assert.equal(ackCards.length, 0, '控制类操作不该发「已收到」卡');
});

// ── 续写链路 ────────────────────────────────────────────────────────────────

test('完成卡里输入下一步指令 → hook 收到 followup_message，Cursor 会自动继续', async () => {
    const event = translateCursorHook(stopFixture);
    const { decision } = await roundTrip({
        event,
        responses: cards.followupResponses(),
        textResponse: { field: 'followup_message' },
        buildCard: (key) => cards.buildFollowupCard({
            event, stateKey: key, body: '已完成', timeoutMs: 4000, waiting: true,
        }),
        action: { tag: 'input', input_value: '顺手把 README 也更新一下', value: { action_type: 'text_input' } },
    });

    assert.deepEqual(decision, { followup_message: '顺手把 README 也更新一下' });
});

test('回话后收敛的完成卡保留正文且仍是绿的（不变灰、不丢内容）', async () => {
    const event = translateCursorHook(stopFixture);
    const body = '把 redirect 默认值改成当前 origin，并补了一条回归测试。';

    const { app } = await roundTrip({
        event,
        responses: cards.followupResponses(),
        textResponse: { field: 'followup_message' },
        buildCard: (key) => cards.buildFollowupCard({
            event, stateKey: key, body, timeoutMs: 4000, waiting: true,
        }),
        buildSettled: (settled) => cards.buildSettledFollowupCard({
            event, body, statusText: settled.text,
        }),
        action: { tag: 'input', input_value: '再更新 README', value: { action_type: 'text_input' } },
    });

    assert.equal(app.patched.length, 1, '应把原卡收敛');
    const settledCard = app.patched[0].card;
    assert.equal(settledCard.header.template, 'green', '任务成功就该保持绿色');
    const json = JSON.stringify(settledCard);
    assert.match(json, /redirect/, '助手正文必须保留');
    assert.match(json, /已续写/, '顶部要有回执');
    assert.doesNotMatch(json, /"tag":"input"/, '交互组件要撤掉');
});

test('点「结束本轮」→ 空裁决，hook 不给 followup_message', async () => {
    const event = translateCursorHook(stopFixture);
    const { decision } = await roundTrip({
        event,
        responses: cards.followupResponses(),
        textResponse: { field: 'followup_message' },
        buildCard: (key) => cards.buildFollowupCard({
            event, stateKey: key, body: '已完成', timeoutMs: 4000, waiting: true,
        }),
        action: { tag: 'button', value: { action_type: 'stop_now' } },
    });

    assert.deepEqual(decision, {});
});

// ── 边界与超时 ──────────────────────────────────────────────────────────────

test('无人作答 → hook 超时拿到 null，卡片收敛为「已超时」', async () => {
    const event = translateCursorHook(shellFixture);
    const app = fakeApp();

    const decision = await cursorHook.askFeishu({
        event,
        app,
        timeoutMs: 150,
        responses: cards.approvalResponses(),
        notificationType: 'cursor_test',
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 150 }),
    });

    assert.equal(decision, null, '超时必须返回 null，让调用方回落到本地');
    assert.match(JSON.stringify(app.patched[0].card), /已超时/);
});

test('超时后再点卡片 → 如实告知未生效，不假报成功', async () => {
    const event = translateCursorHook(shellFixture);
    const app = fakeApp();

    await cursorHook.askFeishu({
        event,
        app,
        timeoutMs: 100,
        responses: cards.approvalResponses(),
        notificationType: 'cursor_test',
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 100 }),
    });

    // hook 已收摊：state 里的通知与 bridge 里的请求都没了。
    // 重放一次「迟到的点击」：手工放回通知，模拟另一台 listener 还留着旧 state 的情形。
    const staleKey = 'feishu_cursor_stale_1';
    sessionState.addNotification(staleKey, {
        host: 'cursor',
        session_id: event.sessionId,
        notification_type: 'cursor_shell_approval',
        pts_device: null,
        decision_id: 'already-closed',
        created_at: Date.now(),
        responses: cards.approvalResponses(),
    });

    const listener = fakeListener([]);
    const result = await FeishuListener.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'allow', session_state_key: staleKey } },
    });
    if (listener._lastInjection) await listener._lastInjection;
    const settled = listener._lastInjection ? await listener._lastInjection : result;

    assert.equal(settled.toast.type, 'warning');
    assert.match(settled.toast.content, /已不在等待/);
});

test('cursor 通知没有 pts_device，但不该被「未找到终端」拦掉', async () => {
    const key = 'feishu_cursor_noterm_1';
    decisionBridge.open('decision-noterm');
    sessionState.addNotification(key, {
        host: 'cursor',
        session_id: 'cursor_x',
        notification_type: 'cursor_shell_approval',
        pts_device: null,
        decision_id: 'decision-noterm',
        created_at: Date.now(),
        responses: cards.approvalResponses(),
    });

    const listener = fakeListener([]);
    const result = await FeishuListener.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'allow', session_state_key: key } },
    });
    if (listener._lastInjection) await listener._lastInjection;

    assert.equal(result, '已收到');
    assert.deepEqual(decisionBridge.read('decision-noterm'), { permission: 'allow' });
    decisionBridge.close('decision-noterm');
});

test('缺少 decision_id 的 cursor 卡片如实报错，而不是静默丢弃', async () => {
    const key = 'feishu_cursor_nodecision_1';
    sessionState.addNotification(key, {
        host: 'cursor',
        session_id: 'cursor_x',
        notification_type: 'cursor_shell_approval',
        pts_device: null,
        created_at: Date.now(),
        responses: cards.approvalResponses(),
    });

    const listener = fakeListener([]);
    const injected = await FeishuListener.prototype._resolveCursorDecision.call(
        listener,
        sessionState.getNotification(key),
        { tag: 'button', value: { action_type: 'allow' } },
        'allow'
    );

    assert.equal(injected.toast.type, 'error');
    assert.match(injected.toast.content, /决策标识/);
});

test('卡片发不出去时绝不阻塞：立刻返回 null 并清掉通知', async () => {
    const event = translateCursorHook(shellFixture);
    const brokenApp = {
        chatId: 'chat-x',
        client: { im: { message: { create: async () => { throw new Error('feishu down'); }, patch: async () => {} } } },
    };

    const started = Date.now();
    const decision = await cursorHook.askFeishu({
        event,
        app: brokenApp,
        timeoutMs: 60000,
        responses: cards.approvalResponses(),
        notificationType: 'cursor_test',
        buildCard: (key) => cards.buildApprovalCard({ event, stateKey: key, timeoutMs: 60000 }),
    });

    assert.equal(decision, null);
    assert.ok(Date.now() - started < 5000, '发卡失败不能还傻等超时');

    sessionState.load();
    const leftover = Object.keys(sessionState.data).filter((k) => k.startsWith('feishu_cursor_conv-9f8'));
    assert.deepEqual(leftover, [], '发卡失败应回滚通知，不留孤儿');
});

// ── 裁决 → 收敛卡文案 ───────────────────────────────────────────────────────

test('describeDecision 按裁决给出对应的收敛文案与配色', () => {
    const responses = cards.approvalResponses();

    assert.equal(cursorHook.describeDecision(responses, { permission: 'allow' }).template, 'green');
    assert.equal(cursorHook.describeDecision(responses, responses.deny.decision).template, 'red');
    assert.equal(cursorHook.describeDecision(responses, { permission: 'ask', user_message: '已交回 Cursor 本地确认' }).template, 'grey');

    const followup = cursorHook.describeDecision({}, { followup_message: '继续' });
    assert.equal(followup.template, 'green');
    assert.match(followup.text, /已续写/);
});

// ── sessionStart：把选择题引导成「可远程作答」的形态 ──────────────────────────

test('sessionStart 注入提问形态约定；关掉开关就什么都不注入', () => {
    const event = translateCursorHook({
        hook_event_name: 'sessionStart',
        session_id: 'conv-steer-1',
        is_background_agent: false,
        composer_mode: 'agent',
    });

    const on = cursorHook.handleSessionStart(event, { steerQuestions: true });
    assert.match(on.additional_context, /AskQuestion/);
    assert.match(on.additional_context, /结束本轮/);

    assert.deepEqual(cursorHook.handleSessionStart(event, { steerQuestions: false }), {});
});

test('后台 agent 不注入：背后没人盯着 IDE，不存在卡在选择题的问题', () => {
    const event = translateCursorHook({
        hook_event_name: 'sessionStart',
        session_id: 'conv-steer-2',
        is_background_agent: true,
    });
    assert.deepEqual(cursorHook.handleSessionStart(event, { steerQuestions: true }), {});
});

// ── 心跳：只在「说完话」之后武装看门狗 ────────────────────────────────────────

test('trackActivity：每个事件都刷心跳并保证有看门狗，stop 则清掉心跳', () => {
    const stall = require('../../src/apps/cursor-stall-watch');
    const config = { stall: { enabled: true, idleMs: 180000 } };
    const calls = { armed: 0, cleared: 0, recorded: [] };

    const origEnsure = stall.ensureWatcher;
    const origClear = stall.clearActivity;
    const origRecord = stall.recordActivity;
    stall.ensureWatcher = () => { calls.armed++; return true; };
    stall.clearActivity = () => { calls.cleared++; };
    stall.recordActivity = (ev) => { calls.recorded.push(ev.meta.eventName); };

    try {
        // 本仓库不处理 afterAgentThought（kind=ignore），但它必须照样刷心跳 ——
        // 它是「agent 还在思考」的唯一证据，漏掉长思考就会被误报成卡死
        cursorHook.trackActivity(translateCursorHook({
            hook_event_name: 'afterAgentThought', session_id: 'c1',
        }), config);
        assert.equal(calls.armed, 1);

        cursorHook.trackActivity(translateCursorHook({
            hook_event_name: 'beforeShellExecution', session_id: 'c1', command: 'make',
        }), config);
        assert.deepEqual(calls.recorded, ['afterAgentThought', 'beforeShellExecution']);

        cursorHook.trackActivity(translateCursorHook({
            hook_event_name: 'stop', session_id: 'c1', status: 'completed',
        }), config);
        assert.equal(calls.cleared, 1, '正常收尾必须清心跳，不能事后再报「疑似在等你」');

        // 开关关掉后完全不参与
        const before = calls.recorded.length;
        cursorHook.trackActivity(translateCursorHook({
            hook_event_name: 'postToolUse', session_id: 'c1', tool_name: 'Shell',
        }), { stall: { enabled: false, idleMs: 1 } });
        assert.equal(calls.recorded.length, before);
    } finally {
        stall.ensureWatcher = origEnsure;
        stall.clearActivity = origClear;
        stall.recordActivity = origRecord;
    }
});
