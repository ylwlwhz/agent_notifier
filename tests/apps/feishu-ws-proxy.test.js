'use strict';

/**
 * 回归测试：listener 必须给 Lark WSClient 传一个「显式代理 agent + proxy:false」的
 * httpInstance，否则在强制代理机上长连接永远建不起来（飞书侧表现为「目标回调服务器未在线」）。
 *
 * 背景（2026-08-13 线上故障）：WSClient 建连前先 POST /callback/ws/endpoint 协商网关地址，
 * 走的是 SDK 自带 axios 实例 —— 构造参数 `agent` 只给 WebSocket，够不到它。而该请求在
 * NODE_USE_ENV_PROXY=1 的机器上会被「双重代理」打死：axios 自己把请求发成
 * `http://proxy:3128 + 绝对 URL` 的正向代理格式，Node 内核又把这个到代理的连接再套一层代理
 * → 代理收到自己发给自己的请求，永不响应，15s 后 `timeout of 15000ms exceeded`，无限重连。
 *
 * 这个测试不联网：stub 掉 Lark SDK，只断言传给 WSClient 的参数形状。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const LISTENER_PATH = require.resolve('../../src/apps/feishu-listener');
const LARK_PATH = require.resolve('@larksuiteoapi/node-sdk');
const TERMINAL_INJECT_PATH = require.resolve('../../src/lib/terminal-inject');
const FEISHU_CLIENT_PATH = require.resolve('../../src/channels/feishu/feishu-client');

function stubModule(path, exports) {
    delete require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

/** 装载 listener，用 stub 的 Lark SDK 捕获 WSClient 收到的构造参数 */
function loadListenerCapturingWsOpts() {
    const captured = [];
    stubModule(LARK_PATH, {
        WSClient: class { constructor(opts) { captured.push(opts); } start() {} close() {} },
        EventDispatcher: class { register() { return this; } },
        LoggerLevel: { info: 2 },
        Domain: { Feishu: 'feishu' },
    });
    stubModule(TERMINAL_INJECT_PATH, {
        resolveTarget: () => null,
        resolvePtsDevice: () => null,
        injectKeys: async () => true,
        injectText: async () => true,
        createTerminalInjector: () => ({}),
        createTerminalRouter: () => ({}),
    });
    // 构造函数会建真 client（取 token），stub 掉避免联网
    stubModule(FEISHU_CLIENT_PATH, {
        createFeishuClient: () => ({ client: {}, sendCard: async () => ({}) }),
    });
    delete require.cache[LISTENER_PATH];
    const { FeishuListener } = require(LISTENER_PATH);
    return { FeishuListener, captured };
}

function withEnv(overrides, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(overrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** 有代理时：WSClient 必须同时拿到 agent 和一个不再做 env 代理解析的 httpInstance */
test('有 http(s)_proxy 时，WSClient 拿到显式 agent + proxy:false 的 httpInstance', () => {
    withEnv({
        https_proxy: 'http://star-proxy.oa.com:3128',
        HTTPS_PROXY: undefined,
        http_proxy: undefined,
        HTTP_PROXY: undefined,
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret_test',
    }, () => {
        const { FeishuListener, captured } = loadListenerCapturingWsOpts();
        const listener = new FeishuListener();
        listener.start();
        clearInterval(listener.healthCheckInterval);
        clearInterval(listener.cleanupInterval);

        assert.equal(captured.length, 1, '应构造一个 WSClient');
        const opts = captured[0];

        // WS 握手本身要走代理
        assert.ok(opts.agent, 'agent 必须存在（ws 库不读 http(s)_proxy）');
        assert.equal(String(opts.agent.proxy), 'http://star-proxy.oa.com:3128/');

        // 网关协商那个 HTTP 请求也要走代理，且必须**关掉** axios 自带 env 解析，
        // 否则 NODE_USE_ENV_PROXY=1 下会双重代理 → 15s 超时、长连接永远建不起来
        assert.ok(opts.httpInstance, 'httpInstance 必须存在，否则 SDK 用自带实例走 env 代理解析');
        assert.equal(opts.httpInstance.defaults.proxy, false, '必须 proxy:false，交给显式 agent');
        assert.ok(opts.httpInstance.defaults.httpsAgent, 'httpsAgent 必须是显式代理 agent');
        assert.ok(opts.httpInstance.defaults.httpAgent, 'httpAgent 必须是显式代理 agent');
    });
});

/** SDK 直接把 response 当 body 用，故必须复刻 defaultHttpInstance 的响应拦截器 */
test('httpInstance 复刻了 SDK 的响应拦截器（否则解构 data.URL 会炸）', () => {
    withEnv({
        https_proxy: 'http://star-proxy.oa.com:3128',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret_test',
    }, () => {
        const { FeishuListener, captured } = loadListenerCapturingWsOpts();
        const listener = new FeishuListener();
        listener.start();
        clearInterval(listener.healthCheckInterval);
        clearInterval(listener.cleanupInterval);

        const handlers = captured[0].httpInstance.interceptors.response.handlers;
        assert.ok(handlers.length >= 1, '必须注册响应拦截器');
        // SDK 里 pullConnectConfig 写的是 `const { code, data: {URL} } = await request(...)`，
        // 即把拦截器返回值当 body 用 —— 拦截器必须剥出 resp.data
        const unwrapped = handlers[0].fulfilled({ config: {}, data: { code: 0, data: { URL: 'wss://x' } } });
        assert.deepEqual(unwrapped, { code: 0, data: { URL: 'wss://x' } }, '应返回 resp.data 本身');
    });
});

/** 无代理机器不能被这个修复影响：保持 SDK 默认行为（直连） */
test('无代理时不传 httpInstance / agent，保持原生直连', () => {
    withEnv({
        https_proxy: undefined,
        HTTPS_PROXY: undefined,
        http_proxy: undefined,
        HTTP_PROXY: undefined,
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret_test',
    }, () => {
        const { FeishuListener, captured } = loadListenerCapturingWsOpts();
        const listener = new FeishuListener();
        listener.start();
        clearInterval(listener.healthCheckInterval);
        clearInterval(listener.cleanupInterval);

        assert.equal(captured[0].agent, undefined, '无代理时不应造 agent');
        assert.equal(captured[0].httpInstance, undefined, '无代理时应交回 SDK 默认实例');
    });
});

/** 僵尸连接重建路径（reconnectWs）也必须带 httpInstance，否则重连全部超时 */
test('重建连接（僵尸恢复）同样带 httpInstance', () => {
    withEnv({
        https_proxy: 'http://star-proxy.oa.com:3128',
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret_test',
    }, () => {
        const { FeishuListener, captured } = loadListenerCapturingWsOpts();
        const listener = new FeishuListener();
        listener.start();
        clearInterval(listener.healthCheckInterval);
        clearInterval(listener.cleanupInterval);

        const before = captured.length;
        listener.reconnect();
        assert.equal(captured.length, before + 1, '应重建一个 WSClient');
        const rebuilt = captured[captured.length - 1];
        assert.ok(rebuilt.httpInstance, '重建时也必须带 httpInstance');
        assert.equal(rebuilt.httpInstance.defaults.proxy, false);
        assert.ok(rebuilt.agent, '重建时也必须带 agent');
    });
});
