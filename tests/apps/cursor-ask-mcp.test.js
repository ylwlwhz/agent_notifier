'use strict';

/**
 * ask_user MCP 服务：协议层 + 答案翻译 + 超时指引。
 *
 * 这个服务存在的理由是 IDE 选择题不可观测（见 docs/ai_rules.md），所以最要紧的两条断言是：
 *   · 协议不能出错 —— 出错的表现是「工具压根不出现」，极难排查
 *   · 任何异常路径都必须给 agent 一段可执行的指引，而不是空手而归；
 *     否则它只会重试或干等，用户在手机上还是什么都拿不到
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const mcp = require('../../src/apps/cursor-ask-mcp');

const SERVER = path.join(__dirname, '..', '..', 'src', 'apps', 'cursor-ask-mcp.js');

/** 起一个真实子进程，喂几行 JSON-RPC，收集 stdout 上的响应 */
function roundtrip(requests, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
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

test('协议：tools/list 暴露 ask_user，且 question 是必填', async () => {
    const msgs = await roundtrip([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const listed = msgs.find((m) => m.id === 2);
    assert.equal(listed.result.tools.length, 1);
    const tool = listed.result.tools[0];
    assert.equal(tool.name, 'ask_user');
    assert.deepEqual(tool.inputSchema.required, ['question']);
    // 工具描述必须点名让 agent 别用 AskQuestion —— 这是它被正确使用的关键
    assert.match(tool.description, /AskQuestion/);
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

test('协议：未知工具名回 -32602；question 为空回 isError 而不是崩', async () => {
    const msgs = await roundtrip([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_user', arguments: { question: '  ' } } },
    ]);
    assert.equal(msgs.find((m) => m.id === 1).error.code, -32602);
    assert.equal(msgs.find((m) => m.id === 2).result.isError, true);
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

test('超时指引必须明确「别重问」，并指向窗口更长的那条路', () => {
    const text = mcp.timeoutGuidance(3000 * 1000);
    assert.match(text, /50 分钟/);
    assert.match(text, /不要再调用 ask_user/);
    assert.match(text, /结束本轮/);
});

test('等待上限默认 50 分钟，留足 IDE 那 60 分钟上限的余量', () => {
    const saved = process.env.CURSOR_ASK_TIMEOUT_SEC;
    delete process.env.CURSOR_ASK_TIMEOUT_SEC;
    try {
        assert.equal(mcp.timeoutMs(), 3000 * 1000);
        process.env.CURSOR_ASK_TIMEOUT_SEC = '120';
        assert.equal(mcp.timeoutMs(), 120 * 1000);
        process.env.CURSOR_ASK_TIMEOUT_SEC = '0';
        assert.equal(mcp.timeoutMs(), 3000 * 1000, '非法值退回默认，不能变成 0 等待');
    } finally {
        if (saved === undefined) delete process.env.CURSOR_ASK_TIMEOUT_SEC;
        else process.env.CURSOR_ASK_TIMEOUT_SEC = saved;
    }
});
