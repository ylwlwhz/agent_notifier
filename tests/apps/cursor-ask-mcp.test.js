'use strict';

/**
 * ask_user MCP 服务：协议层 + 答案翻译 + 超时指引。
 *
 * 这个服务存在的理由是 IDE 选择题不可观测（见 docs/ai_rules.md），所以最要紧的两条断言是：
 *   · 协议不能出错 —— 出错的表现是「工具压根不出现」，极难排查
 *   · 任何异常路径都必须给 agent 一段可执行的指引，而不是空手而归；
 *     否则它只会重试或干等，用户在手机上还是什么都拿不到
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require 之前改：session-state / decision-bridge 都是模块加载时按 env 定好路径的单例。
// 不改的话这个文件会往真实的 /tmp 决策目录和仓库里的 session-state.json 写东西。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'an-ask-mcp-'));
process.env.AGENT_NOTIFIER_STATE = path.join(TMP, 'session-state.json');
process.env.AGENT_NOTIFIER_DECISIONS = path.join(TMP, 'decisions');

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const mcp = require('../../src/apps/cursor-ask-mcp');
const { decisionBridge } = require('../../src/lib/decision-bridge');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SERVER = path.join(__dirname, '..', '..', 'src', 'apps', 'cursor-ask-mcp.js');

/**
 * 只截走本模块写到 stdout 的 JSON-RPC 行，其余（node:test 自己的报告输出）原样放行。
 *
 * 一定不能整个吞掉 process.stdout.write：实测那样会把 runner 的报告一起吃掉，
 * 表现是「明明注册了 19 个用例，报告里只剩 7 个」，而且不报任何错。
 */
function captureRpc() {
    const lines = [];
    const raw = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
        const text = String(chunk);
        if (text.startsWith('{"jsonrpc"')) {
            lines.push(text);
            if (typeof cb === 'function') cb();
            return true;
        }
        return raw(chunk, enc, cb);
    };
    lines.restore = () => { process.stdout.write = raw; };
    return lines;
}

/** 起一个真实子进程，喂几行 JSON-RPC，收集 stdout 上的响应 */
function roundtrip(requests, { timeoutMs = 8000, env = {} } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER], {
            stdio: ['pipe', 'pipe', 'pipe'],
            // dotenv 只跳过【已存在】的键，所以显式传空串就能盖住仓库 .env 里的同名项
            env: { ...process.env, ...env },
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('子进程超时')); }, timeoutMs);

        child.stdout.on('data', (d) => { out += d; });
        child.on('close', () => {
            clearTimeout(timer);
            const msgs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
            resolve(msgs);
        });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });

        for (const req of requests) child.stdin.write(JSON.stringify(req) + '\n');
        child.stdin.end();
    });
}

test('协议：initialize 回显客户端版本并声明 tools 能力', async () => {
    const [init] = await roundtrip([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    ]);
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'agent-notifier-ask');
});

test('协议：tools/list 暴露 ask_user 与 ask_user_wait', async () => {
    const msgs = await roundtrip([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const tools = msgs.find((m) => m.id === 2).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['ask_user', 'ask_user_wait']);
    assert.deepEqual(tools[0].inputSchema.required, ['question']);
    assert.deepEqual(tools[1].inputSchema.required, ['pending_id']);
    // 工具描述必须点名让 agent 别用 AskQuestion —— 这是它被正确使用的关键
    assert.match(tools[0].description, /AskQuestion/);
});

// ── 归属过滤：共享 root 的机器上，别人的窗口不该拿到这个工具 ────────────────────
//
// GY_2 实测：同时跑着 5 个本服务进程，其中 4 个属于同事的窗口。他的 agent 调一次
// ask_user，卡片就发到你手机上、他的会话阻塞最长 24 小时。MCP 进程拿不到账号信息
// （环境里只有 WORKSPACE_FOLDER_PATHS），所以这条只能靠工作区路径拦。

const OWNER_ENV = { CURSOR_NOTIFY_ROOTS: '/apdcephfs_private/qy/projects/whz', CURSOR_NOTIFY_USERS: '' };

test('归属过滤：白名单内的工作区照常拿到两个工具', async () => {
    const msgs = await roundtrip([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], {
        env: { ...OWNER_ENV, WORKSPACE_FOLDER_PATHS: '/apdcephfs_private/qy/projects/whz/agent_notifier' },
    });
    assert.deepEqual(msgs[0].result.tools.map((t) => t.name), ['ask_user', 'ask_user_wait']);
});

test('归属过滤：同事的工作区里 tools/list 直接为空，他的 agent 看不见这个工具', async () => {
    const msgs = await roundtrip([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], {
        env: { ...OWNER_ENV, WORKSPACE_FOLDER_PATHS: '/apdcephfs_private/qy/projects/wjj/starVLA' },
    });
    assert.deepEqual(msgs[0].result.tools, []);
});

test('归属过滤：认不出工作区就不给（fail-closed）', async () => {
    const msgs = await roundtrip([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], {
        env: { ...OWNER_ENV, WORKSPACE_FOLDER_PATHS: '' },
    });
    assert.deepEqual(msgs[0].result.tools, []);
});

test('归属过滤：真被调到也要立刻给条能走的路，绝不能挂在那儿等', async () => {
    const msgs = await roundtrip([{
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'ask_user', arguments: { question: '选 A 还是 B？' } },
    }], {
        env: { ...OWNER_ENV, WORKSPACE_FOLDER_PATHS: '/apdcephfs_private/qy/projects/wjj/starVLA' },
    });

    const text = msgs[0].result.content[0].text;
    assert.match(text, /未启用/);
    // 必须指回「正文列选项 + 结束本轮」，否则别人的 agent 只会重试或干等
    assert.match(text, /结束本轮/);
    assert.notEqual(msgs[0].result.isError, true, '报错在用户那边只显示「工具失败」，说明不了任何事');
});

test('没配白名单就不过滤：单人机器不该被逼着写配置', () => {
    const saved = process.env.CURSOR_NOTIFY_ROOTS;
    process.env.CURSOR_NOTIFY_ROOTS = '';
    mcp.resetWorkspaceAllowed();
    try {
        assert.equal(mcp.workspaceAllowed(), true);
    } finally {
        if (saved === undefined) delete process.env.CURSOR_NOTIFY_ROOTS;
        else process.env.CURSOR_NOTIFY_ROOTS = saved;
        mcp.resetWorkspaceAllowed();
    }
});

test('协议：通知没有 id，绝不能回响应（否则客户端会报协议错误）', async () => {
    const msgs = await roundtrip([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 9, method: 'ping' },
    ]);
    assert.equal(msgs.length, 1, '只该有 ping 那一条响应');
    assert.equal(msgs[0].id, 9);
});

test('协议：未实现的方法如实回 -32601，不静默（否则客户端一直等）', async () => {
    const [msg] = await roundtrip([{ jsonrpc: '2.0', id: 3, method: 'resources/list' }]);
    assert.equal(msg.error.code, -32601);
});

test('协议：未知工具名回 -32602；必填参数为空回 isError 而不是崩', async () => {
    const msgs = await roundtrip([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user', arguments: { question: '  ' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_user_wait', arguments: {} } },
    ]);
    assert.equal(msgs.find((m) => m.id === 1).error.code, -32602);
    assert.equal(msgs.find((m) => m.id === 2).result.isError, true);
    assert.equal(msgs.find((m) => m.id === 3).result.isError, true);
});

test('没配飞书凭据时不阻塞，直接给出「改用正文提问」的指引', async () => {
    // 必须置空而不是 delete：askUser 内部会 require env-config，它调 dotenv 重新加载 .env，
    // 而 dotenv 只跳过【已存在】的键 —— delete 掉真实凭据会被重新灌回来，
    // 这条用例就会真的发一张卡到飞书并阻塞几十分钟（实测踩过）。
    const keys = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_CHAT_ID'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; process.env[k] = ''; }
    try {
        const text = await mcp.askUser({ question: '选 A 还是 B？' });
        assert.match(text, /写进正文/);
        assert.match(text, /结束本轮/);
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
});

test('答案翻译：点选项带出编号，自定义回答原样带出，取消给出「自己决定」指引', () => {
    const options = ['方案 A', '方案 B'];
    assert.match(mcp.describeAnswer({ answer: '方案 B' }, options), /第 2 个选项：方案 B/);
    assert.match(mcp.describeAnswer({ answer: '都不行，先放着' }, options), /用户的回答：都不行/);
    assert.match(mcp.describeAnswer({ cancelled: true }, options), /不要重复问/);
    assert.equal(mcp.describeAnswer(null, options), null, '超时必须返回 null，交给超时指引');
    assert.equal(mcp.describeAnswer({ answer: '   ' }, options), null, '空答案不算回答');
});

test('总窗口到期的指引必须明确「别重问」，并指向完成卡那条路', () => {
    const text = mcp.timeoutGuidance(43200 * 1000);
    assert.match(text, /12 小时/);
    assert.match(text, /不要再调用 ask_user/);
    assert.match(text, /结束本轮/);
});

test('续等指引必须带上 pending_id，并明确要求下一步就调 ask_user_wait', () => {
    // 含糊的措辞会让 agent 自己往下跑，用户几小时后点了卡片却没人接
    const text = mcp.pendingGuidance('cursorask_123_ab', 40000 * 1000);
    assert.match(text, /pending_id=cursorask_123_ab/);
    assert.match(text, /ask_user_wait\(\{ pending_id: "cursorask_123_ab" \}\)/);
    assert.match(text, /11\.1 小时|小时/);
    assert.match(text, /写进正文/, '也要给出「不想等了」的另一条明路');
});

test('时长文案：不足一小时按分钟，超过按小时', () => {
    assert.equal(mcp.humanDuration(30 * 60000), '30 分钟');
    assert.equal(mcp.humanDuration(3000 * 1000), '50 分钟');
    assert.equal(mcp.humanDuration(43200 * 1000), '12 小时');
});

test('总窗口默认 24 小时（与完成卡对齐），单段默认 50 分钟（绕开 60 分钟硬顶）', () => {
    const keys = ['CURSOR_ASK_TIMEOUT_SEC', 'CURSOR_ASK_CHUNK_SEC'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
        assert.equal(mcp.timeoutMs(), 86400 * 1000);
        assert.equal(mcp.chunkMs(), 3000 * 1000);

        process.env.CURSOR_ASK_TIMEOUT_SEC = '120';
        assert.equal(mcp.timeoutMs(), 120 * 1000);
        assert.equal(mcp.chunkMs(), 120 * 1000, '分段不该比总窗口还长');

        process.env.CURSOR_ASK_TIMEOUT_SEC = '0';
        assert.equal(mcp.timeoutMs(), 86400 * 1000, '非法值退回默认，不能变成 0 等待');
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
});

test('续等：pending_id 不存在时给出可执行的退路，而不是抛异常', async () => {
    const text = await mcp.waitChunk('cursorask_not_here');
    assert.match(text, /已经结束或不存在/);
    assert.match(text, /写进正文/);
});

test('单段永不顶到客户端 60 分钟硬顶（撞上就是 -32001，用户只看到「工具失败」）', () => {
    const keys = ['CURSOR_ASK_TIMEOUT_SEC', 'CURSOR_ASK_CHUNK_SEC'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try {
        process.env.CURSOR_ASK_CHUNK_SEC = '7200'; // 有人手配 2 小时
        assert.equal(mcp.chunkMs(), mcp.CLIENT_MAX_CALL_MS - 5 * 60 * 1000);
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
});

test('心跳间隔默认 20s，且不允许配得比 120s 的 idle 上限还长', () => {
    const saved = process.env.CURSOR_ASK_HEARTBEAT_SEC;
    try {
        delete process.env.CURSOR_ASK_HEARTBEAT_SEC;
        assert.equal(mcp.heartbeatMs(), 20 * 1000);

        process.env.CURSOR_ASK_HEARTBEAT_SEC = '600';
        assert.equal(mcp.heartbeatMs(), mcp.CLIENT_IDLE_TIMEOUT_MS / 2, '配长了必须夹回来，否则等于没心跳');

        process.env.CURSOR_ASK_HEARTBEAT_SEC = 'abc';
        assert.equal(mcp.heartbeatMs(), 20 * 1000);
    } finally {
        if (saved === undefined) delete process.env.CURSOR_ASK_HEARTBEAT_SEC;
        else process.env.CURSOR_ASK_HEARTBEAT_SEC = saved;
    }
});

test('没拿到 progressToken 就没法续命，单段必须退化到 idle 上限之内', () => {
    // 有 token：靠心跳撑满 50 分钟
    assert.equal(mcp.sliceMsFor(1), mcp.chunkMs());
    assert.equal(mcp.sliceMsFor(0), mcp.chunkMs(), 'token 可以是数字 0，别被假值坑了');
    // 没 token：抢在 120 秒判死之前把控制权还给 agent
    assert.equal(mcp.sliceMsFor(undefined), mcp.NO_TOKEN_CHUNK_MS);
    assert.equal(mcp.sliceMsFor(null), mcp.NO_TOKEN_CHUNK_MS);
    assert.ok(mcp.NO_TOKEN_CHUNK_MS < mcp.CLIENT_IDLE_TIMEOUT_MS);
});

test('心跳原样回客户端给的 progressToken；没 token 时不发（发了是协议噪音）', () => {
    const sent = captureRpc();
    try {
        assert.equal(mcp.sendProgress(7, 3, '还在等'), true);
        assert.equal(mcp.sendProgress(undefined, 1, '还在等'), false);
        assert.equal(mcp.sendProgress(null, 1, '还在等'), false);
    } finally {
        sent.restore();
    }

    assert.equal(sent.length, 1);
    const msg = JSON.parse(sent[0]);
    assert.equal(msg.method, 'notifications/progress');
    assert.equal(msg.params.progressToken, 7);
    assert.equal(msg.params.progress, 3);
    assert.equal(msg.id, undefined, '通知不能带 id');
});

test('心跳期间真的等满一段：wait 被 heartbeat 包着也照样拿到落盘的答案', async () => {
    const id = 'cursorask_hb_1';
    decisionBridge.open(id, { host: 'cursor', event: 'mcp_ask_user', timeoutMs: 60000 });

    const savedBeat = process.env.CURSOR_ASK_HEARTBEAT_SEC;
    process.env.CURSOR_ASK_HEARTBEAT_SEC = '0.05'; // 50ms，逼出至少一次心跳
    const sent = captureRpc();

    mcp.pending.set(id, {
        decisionId: id,
        stateKey: 'k',
        messageId: null,
        client: null,
        question: 'A 还是 B',
        options: ['A', 'B'],
        deadline: Date.now() + 5000,
        totalMs: 5000,
    });

    try {
        setTimeout(() => decisionBridge.resolve(id, { answer: 'B' }), 200);
        const text = await mcp.waitChunk(id, 42);
        assert.match(text, /第 2 个选项：B/);
    } finally {
        sent.restore();
        mcp.pending.delete(id);
        decisionBridge.close(id);
        if (savedBeat === undefined) delete process.env.CURSOR_ASK_HEARTBEAT_SEC;
        else process.env.CURSOR_ASK_HEARTBEAT_SEC = savedBeat;
    }

    const beats = sent.map((l) => JSON.parse(l)).filter((m) => m.method === 'notifications/progress');
    assert.ok(beats.length >= 1, '等待期间必须发出心跳，否则 120 秒后被判死');
    assert.equal(beats[0].params.progressToken, 42);
});

test('客户端取消后立刻收手：不再干等，也不把答案吞进一个没人收的返回值', async () => {
    const id = 'cursorask_cancel_1';
    decisionBridge.open(id, { host: 'cursor', event: 'mcp_ask_user', timeoutMs: 60000 });

    mcp.pending.set(id, {
        decisionId: id,
        stateKey: 'k',
        messageId: null,
        client: null,
        question: 'A 还是 B',
        options: ['A', 'B'],
        deadline: Date.now() + 60000,
        totalMs: 60000,
    });
    mcp.byRequestId.set('11', id);

    try {
        setTimeout(() => {
            assert.equal(mcp.cancelRequest(11), true);
        }, 150);
        const started = Date.now();
        const text = await mcp.waitChunk(id, 5);
        assert.match(text, /已被 IDE 取消/);
        assert.ok(Date.now() - started < 5000, '取消必须当场生效，不能等到分段到期');
        assert.equal(mcp.pending.has(id), false, '取消后必须收摊，别留下永久有效的卡');
    } finally {
        mcp.pending.delete(id);
        mcp.byRequestId.delete('11');
        decisionBridge.close(id);
    }
});

test('协议：notifications/cancelled 是通知，不能回响应，也不能崩', async () => {
    const msgs = await roundtrip([
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'timeout' } },
        { jsonrpc: '2.0', id: 5, method: 'ping' },
    ]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, 5);
});
