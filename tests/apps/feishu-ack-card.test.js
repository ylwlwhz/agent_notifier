'use strict';

/**
 * 回归测试：用户在卡片上选择选项 / 给出对话回复后，listener 立即另发一张"已收到"卡，
 * 终端注入放后台执行（this._lastInjection）。控制类操作（中断/Esc）不发"已收到"卡。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionState } = require('../../src/lib/session-state');

const TERMINAL_INJECT_PATH = require.resolve('../../src/lib/terminal-inject');
const LISTENER_PATH = require.resolve('../../src/apps/feishu-listener');

function makeTempSessionState() {
    return new SessionState(`/tmp/test-ack-card-session-${process.pid}-${Math.floor(performance.now())}.json`);
}

function stubTerminalInject(injections) {
    delete require.cache[TERMINAL_INJECT_PATH];
    require.cache[TERMINAL_INJECT_PATH] = {
        id: TERMINAL_INJECT_PATH,
        filename: TERMINAL_INJECT_PATH,
        loaded: true,
        exports: {
            resolveTarget: () => null,
            resolvePtsDevice: () => null,
            injectKeys: async (_t, keys) => { injections.push(keys); return true; },
            injectText: async (_t, text) => { injections.push(text); return true; },
            createTerminalInjector: () => ({}),
            createTerminalRouter: () => ({}),
        },
    };
}

function loadFreshListener(injections) {
    delete require.cache[LISTENER_PATH];
    stubTerminalInject(injections);
    return require('../../src/apps/feishu-listener').FeishuListener;
}

function makeFakeListener(FL, state, sent) {
    const listener = Object.create(FL.prototype);
    listener.state = state;
    listener.client = {
        im: { message: { create: async ({ data }) => { sent.push(JSON.parse(data.content)); return { data: { message_id: 'm' } }; } } },
    };
    listener.sleep = () => Promise.resolve();
    listener.codexInputBridge = null;
    listener.unifiedInteractionHandler = null;
    return listener;
}

const KEY = 'ack-test-key';
function addSingleQuestion(state) {
    state.addNotification(KEY, {
        session_id: 's', notification_type: 'AskUserQuestion', pts_device: 'fifo:/tmp/ack',
        created_at: Date.now(),
        responses: {
            opt_0: { keys: '\r', label: '选项甲' },
            interrupt: { keys: '\x1b', label: '⛔ Interrupt' },
        },
    });
}

test('点击选项 → 立即发"已收到"卡（blue + 宿主标签 + 回显所选），注入走后台', async () => {
    const injections = [];
    const FL = loadFreshListener(injections);
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addSingleQuestion(state);

    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });

    assert.equal(ret, '已收到', 'handleCardAction 应即时返回"已收到"，不等注入跑完');
    assert.ok(listener._lastInjection, '应把后台注入挂在 _lastInjection 上');

    await listener._lastInjection;
    assert.deepEqual(injections, ['\r'], '后台应注入 opt_0 的 \\r');

    assert.equal(sent.length, 1, '应只发一张"已收到"卡');
    const card = sent[0];
    assert.equal(card.header?.title?.content, '已收到');
    assert.equal(card.header?.template, 'blue');
    assert.ok(card.header?.text_tag_list?.some(t => t.text?.content === 'Claude'), '应带 Claude 宿主标签');
    const md = JSON.stringify(card.body?.elements || []);
    assert.ok(md.includes('选项甲'), '"已收到"卡应回显所选项 label');

    delete require.cache[LISTENER_PATH];
});

test('对话回复（输入框） → "已收到"卡回显回复文本', async () => {
    const injections = [];
    const FL = loadFreshListener(injections);
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addSingleQuestion(state);

    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'input', input_value: '继续执行下一步', value: { action_type: 'text_input', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });

    assert.equal(ret, '已收到');
    await listener._lastInjection;
    assert.deepEqual(injections, ['继续执行下一步'], '后台应注入回复文本');
    assert.equal(sent.length, 1);
    assert.ok(JSON.stringify(sent[0].body?.elements).includes('继续执行下一步'), '"已收到"卡应回显回复文本');

    delete require.cache[LISTENER_PATH];
});

test('回调不带 open_chat_id 且通知无 _chat_id → 靠 FEISHU_CHAT_ID 兜底仍发"已收到"卡', async () => {
    const injections = [];
    const FL = loadFreshListener(injections);
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addSingleQuestion(state); // 单选通知不含 _chat_id

    const prev = process.env.FEISHU_CHAT_ID;
    process.env.FEISHU_CHAT_ID = 'env-chat';
    try {
        await FL.prototype.handleCardAction.call(listener, {
            // 注意：无 context，模拟飞书回调多数不带 open_chat_id 的真实情况
            action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: KEY } },
        });
        await listener._lastInjection;
        assert.equal(sent.length, 1, 'open_chat_id 缺失时应回退到 FEISHU_CHAT_ID 发卡');
        assert.equal(sent[0].header?.title?.content, '已收到');
    } finally {
        if (prev === undefined) delete process.env.FEISHU_CHAT_ID; else process.env.FEISHU_CHAT_ID = prev;
    }

    delete require.cache[LISTENER_PATH];
});

test('发"已收到"卡后记录 received_msg_<sessionKey>，供 claude-live 执行摘要 patch 合并', async () => {
    const injections = [];
    const FL = loadFreshListener(injections);
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    // session_id 带 claude_ 前缀，验证 sessionKey 对齐 claude-live（去前缀后 slice(0,8)）
    state.addNotification(KEY, {
        session_id: 'claude_abcd1234ef', notification_type: 'AskUserQuestion', pts_device: 'fifo:/tmp/ack',
        created_at: Date.now(), responses: { opt_0: { keys: '\r', label: '选项甲' } },
    });
    const notif = state.getNotification(KEY);

    const prev = process.env.FEISHU_CHAT_ID;
    process.env.FEISHU_CHAT_ID = 'env-chat';
    try {
        await listener._sendReceivedCard({}, notif, { tag: 'button', value: { action_type: 'opt_0' } }, 'opt_0');
        const rec = state.getNotification('received_msg_abcd1234');
        assert.ok(rec, 'received_msg_<sessionKey> 应被写入');
        assert.equal(rec.message_id, 'm', '应记录"已收到"卡的 message_id');
        assert.ok(rec.created_at > 0, '应带时间戳供 TTL 判定');
        assert.ok(rec.detail.includes('选项甲'), '应带回执文案 detail，供合并卡顶部展示');
    } finally {
        if (prev === undefined) delete process.env.FEISHU_CHAT_ID; else process.env.FEISHU_CHAT_ID = prev;
    }

    delete require.cache[LISTENER_PATH];
});

test('codex 回复不写 received_msg（执行摘要合并仅限 Claude）', async () => {
    const injections = [];
    const FL = loadFreshListener(injections);
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    state.addNotification(KEY, {
        session_id: 'codex_xyz', host: 'codex', notification_type: 'execution_summary', pts_device: 'pts/3',
        created_at: Date.now(), responses: {},
    });
    const notif = state.getNotification(KEY);

    const prev = process.env.FEISHU_CHAT_ID;
    process.env.FEISHU_CHAT_ID = 'env-chat';
    try {
        await listener._sendReceivedCard({}, notif, { tag: 'input', input_value: 'hi', value: { action_type: 'text_input' } }, 'text_input');
        // 不应写任何 received_msg_* 键
        state.load();
        const hasReceived = Object.keys(state.data).some(k => k.startsWith('received_msg_'));
        assert.equal(hasReceived, false, 'codex 不应写 received_msg');
    } finally {
        if (prev === undefined) delete process.env.FEISHU_CHAT_ID; else process.env.FEISHU_CHAT_ID = prev;
    }

    delete require.cache[LISTENER_PATH];
});

test('中断按钮属于控制类 → 不发"已收到"卡，同步注入并返回原标签', async () => {
    const injections = [];
    const FL = loadFreshListener(injections);
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addSingleQuestion(state);

    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'interrupt', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });

    assert.equal(ret, '⛔ Interrupt', '控制类应同步返回 responseEntry.label');
    assert.equal(sent.length, 0, '控制类不应发"已收到"卡');
    assert.deepEqual(injections, ['\x1b'], '应已同步注入 Esc');

    delete require.cache[LISTENER_PATH];
});
