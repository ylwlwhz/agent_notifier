'use strict';

/**
 * 回归测试：注入失败必须如实报错，不能假报「已收到」/「已操作」。
 *
 * 背景：ack 是故意做成 fire-and-forget 的（飞书回调有超时），于是注入失败只进
 * stderr，toast 照常报成功。macOS 上注入曾因 tty 命名不同而整体失效（见
 * tests/lib/terminal-inject.test.js），表现就是「卡片显示已收到，但 claude 没收到」——
 * 正是被这里掩盖掉的。现在回调会短等注入结果，失败则把真实错误报进 toast。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionState } = require('../../src/lib/session-state');

const TERMINAL_INJECT_PATH = require.resolve('../../src/lib/terminal-inject');
const LISTENER_PATH = require.resolve('../../src/apps/feishu-listener');

function makeTempSessionState() {
    return new SessionState(`/tmp/test-inject-fail-${process.pid}-${Math.floor(performance.now())}.json`);
}

/** inject 桩：failWith 非空则抛该错误；delayMs 用于模拟慢注入。 */
function stubTerminalInject({ failWith = null, delayMs = 0 } = {}) {
    delete require.cache[TERMINAL_INJECT_PATH];
    const act = async () => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (failWith) throw new Error(failWith);
        return true;
    };
    require.cache[TERMINAL_INJECT_PATH] = {
        id: TERMINAL_INJECT_PATH,
        filename: TERMINAL_INJECT_PATH,
        loaded: true,
        exports: {
            resolveTarget: () => null,
            resolvePtsDevice: () => null,
            injectKeys: act,
            injectText: act,
            createTerminalInjector: () => ({}),
            createTerminalRouter: () => ({}),
        },
    };
}

function loadFreshListener(stubOpts) {
    delete require.cache[LISTENER_PATH];
    stubTerminalInject(stubOpts);
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

const KEY = 'inject-fail-key';
function addQuestion(state) {
    state.addNotification(KEY, {
        session_id: 's', notification_type: 'AskUserQuestion', pts_device: '/dev/ttys999',
        responses: {
            opt_0: { keys: '\r', label: '选项甲' },
            interrupt: { keys: '\x1b', label: '⛔ Interrupt' },
        },
    });
}

const ERR = 'Unknown target format: /dev/ttys999';

test('按钮注入失败 → error toast 带真实原因，不是「已收到」', async () => {
    const FL = loadFreshListener({ failWith: ERR });
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addQuestion(state);

    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });
    await (listener._lastInjection || Promise.resolve()).catch(() => {});

    assert.equal(typeof ret, 'object', '失败时应返回 { toast }，而不是字符串「已收到」');
    assert.equal(ret.toast.type, 'error', 'toast 类型应为 error');
    assert.match(ret.toast.content, /注入失败/, 'toast 应说明注入失败');
    assert.match(ret.toast.content, /Unknown target format/, 'toast 应带真实错误原因，便于定位');
    assert.notEqual(ret, '已收到');

    delete require.cache[LISTENER_PATH];
});

test('文本回复注入失败 → error toast，不再静默', async () => {
    const FL = loadFreshListener({ failWith: ERR });
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addQuestion(state);

    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'input', input_value: '继续执行', value: { action_type: 'text_input', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });
    await (listener._lastInjection || Promise.resolve()).catch(() => {});

    assert.equal(ret?.toast?.type, 'error', '文本注入失败也应报 error toast');
    assert.match(ret.toast.content, /注入失败/);

    delete require.cache[LISTENER_PATH];
});

test('注入成功 → 仍然即时返回「已收到」（不破坏 fast-ack 设计）', async () => {
    const FL = loadFreshListener({});
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addQuestion(state);

    const t0 = performance.now();
    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });
    const elapsed = performance.now() - t0;
    await listener._lastInjection;

    assert.equal(ret, '已收到', '成功路径必须保持原样');
    assert.ok(elapsed < 500, `成功路径不应被 deadline 拖慢，实际 ${Math.round(elapsed)}ms`);

    delete require.cache[LISTENER_PATH];
});

test('注入很慢但尚未失败 → 不干等，仍回「已收到」（此刻结果确实未知）', async () => {
    // deadline 调到 50ms，注入要 400ms：回调不能被吊住
    process.env.FEISHU_INJECT_TOAST_DEADLINE_MS = '50';
    try {
        const FL = loadFreshListener({ delayMs: 400 });
        const state = makeTempSessionState();
        const sent = [];
        const listener = makeFakeListener(FL, state, sent);
        addQuestion(state);

        const t0 = performance.now();
        const ret = await FL.prototype.handleCardAction.call(listener, {
            action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: KEY } },
            context: { open_chat_id: 'chat-x' },
        });
        const elapsed = performance.now() - t0;

        assert.equal(ret, '已收到', '超时未决时回「已收到」是诚实的');
        assert.ok(elapsed < 300, `不应等满整个注入，实际 ${Math.round(elapsed)}ms`);
        await listener._lastInjection; // 后台仍要跑完，不被取消
        delete require.cache[LISTENER_PATH];
    } finally {
        delete process.env.FEISHU_INJECT_TOAST_DEADLINE_MS;
    }
});

test('控制类（中断）注入失败 → 同步路径也报 error toast', async () => {
    const FL = loadFreshListener({ failWith: ERR });
    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);
    addQuestion(state);

    const ret = await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'interrupt', session_state_key: KEY } },
        context: { open_chat_id: 'chat-x' },
    });

    assert.equal(ret?.toast?.type, 'error', '中断失败不应被当成成功');
    assert.equal(sent.length, 0, '控制类仍不发"已收到"卡');

    delete require.cache[LISTENER_PATH];
});
