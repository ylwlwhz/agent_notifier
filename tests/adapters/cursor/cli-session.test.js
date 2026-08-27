'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
    newCliSessionId,
    buildAgentArgs,
    parseStreamEvent,
    createLineSplitter,
    runAgentTurn,
    toolNameFromCall,
    summarizeArgs,
    summarizeToolResult,
} = require('../../../src/adapters/cursor/cli-session');

// 真实事件样本（2026-08-26 从 cursor-agent 2026.08.11-e8db854 抓的 stream-json）
const INIT = {
    type: 'system', subtype: 'init', apiKeySource: 'login',
    cwd: '/tmp/probe', session_id: 'sid-1', model: 'Auto Balance', permissionMode: 'default',
};
const ASSISTANT = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '我先读 hello.txt。' }] },
    session_id: 'sid-1',
};
const TOOL_STARTED = {
    type: 'tool_call', subtype: 'started', call_id: 'call-1',
    tool_call: { readToolCall: { args: { path: '/tmp/probe/hello.txt' } }, toolCallId: 'call-1' },
};
const TOOL_COMPLETED = {
    type: 'tool_call', subtype: 'completed', call_id: 'call-1',
    tool_call: {
        readToolCall: {
            args: { path: '/tmp/probe/hello.txt' },
            result: { success: { content: 'line one\nline two\n', totalLines: 3 } },
        },
        toolCallId: 'call-1',
    },
};
const RESULT = {
    type: 'result', subtype: 'success', is_error: false, duration_ms: 14670,
    result: 'hello.txt 一共有 2 行。', session_id: 'sid-1',
    usage: { inputTokens: 22027, outputTokens: 87, cacheReadTokens: 5888, cacheWriteTokens: 0 },
};

test('会话 id 自己生成且唯一（未知 id 会被 CLI 静默新建，所以我们从诞生起就拥有它）', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCliSessionId()));
    assert.equal(ids.size, 100);
    assert.match(newCliSessionId(), /^[0-9a-f-]{36}$/);
});

test('buildAgentArgs 带齐脚本化必需项：-p / --trust / --resume / --workspace', () => {
    const args = buildAgentArgs({
        sessionId: 'sid-1', workspace: '/proj', prompt: '跑测试', outputFormat: 'stream-json',
    });

    assert.ok(args.includes('-p'), '必须非交互');
    assert.ok(args.includes('--trust'), '不带 --trust 会被未受信任工作区直接拒绝');
    assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sid-1']);
    assert.deepEqual(args.slice(args.indexOf('--workspace'), args.indexOf('--workspace') + 2), ['--workspace', '/proj']);
    assert.equal(args[args.length - 1], '跑测试', 'prompt 作为位置参数放最后');
});

test('buildAgentArgs 默认放行工具（否则无人值守会停在批准提示上）', () => {
    assert.ok(buildAgentArgs({ sessionId: 's', workspace: '/p' }).includes('--force'));
    assert.ok(!buildAgentArgs({ sessionId: 's', workspace: '/p', force: false }).includes('--force'));
});

test('buildAgentArgs 缺少必需项时抛错，而不是拼出一条会静默分叉的命令', () => {
    assert.throws(() => buildAgentArgs({ workspace: '/p' }), /sessionId/);
    assert.throws(() => buildAgentArgs({ sessionId: 's' }), /workspace/);
});

test('parseStreamEvent 解析 system/init', () => {
    assert.deepEqual(parseStreamEvent(JSON.stringify(INIT)), {
        kind: 'init', sessionId: 'sid-1', model: 'Auto Balance', cwd: '/tmp/probe',
    });
});

test('parseStreamEvent 解析 assistant 文本', () => {
    assert.deepEqual(parseStreamEvent(JSON.stringify(ASSISTANT)), {
        kind: 'text', text: '我先读 hello.txt。',
    });
});

test('parseStreamEvent 从 oneof 里认出工具名与入参', () => {
    const started = parseStreamEvent(JSON.stringify(TOOL_STARTED));
    assert.equal(started.kind, 'tool_started');
    assert.equal(started.tool, 'Read');
    assert.equal(started.icon, '📖');
    assert.equal(started.input, '/tmp/probe/hello.txt');
    assert.equal(started.callId, 'call-1');
});

test('parseStreamEvent 解析工具结果并标记成败', () => {
    const done = parseStreamEvent(JSON.stringify(TOOL_COMPLETED));
    assert.equal(done.kind, 'tool_completed');
    assert.equal(done.ok, true);
    assert.equal(done.result, 'line one\nline two\n');
    assert.equal(done.callId, 'call-1', 'callId 必须能与 started 配对');
});

test('parseStreamEvent 解析 result 并带出 usage/时长', () => {
    const r = parseStreamEvent(JSON.stringify(RESULT));
    assert.equal(r.kind, 'result');
    assert.equal(r.isError, false);
    assert.equal(r.text, 'hello.txt 一共有 2 行。');
    assert.equal(r.durationMs, 14670);
    assert.equal(r.usage.inputTokens, 22027);
});

test('parseStreamEvent 忽略暂不上卡的事件与脏行', () => {
    assert.equal(parseStreamEvent(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'x' })), null);
    assert.equal(parseStreamEvent(JSON.stringify({ type: 'user' })), null);
    assert.equal(parseStreamEvent('not json'), null);
    assert.equal(parseStreamEvent(''), null);
    assert.equal(parseStreamEvent(null), null);
});

test('result 的错误态被识别（要能把红卡和绿卡分开）', () => {
    const r = parseStreamEvent(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '炸了' }));
    assert.equal(r.isError, true);
    assert.equal(r.text, '炸了');
});

test('toolNameFromCall 认不出时不崩', () => {
    assert.equal(toolNameFromCall({ shellToolCall: {} }), 'Shell');
    assert.equal(toolNameFromCall({ nope: {} }), null);
    assert.equal(toolNameFromCall(null), null);
});

test('summarizeArgs 对不同工具取最有信息量的字段', () => {
    assert.equal(summarizeArgs({ command: 'npm test' }), 'npm test');
    assert.equal(summarizeArgs({ path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(summarizeArgs({ pattern: 'TODO' }), 'TODO');
    assert.equal(summarizeArgs(null), '');
});

test('summarizeToolResult 兼容 success/error 与 stdout+stderr', () => {
    assert.deepEqual(summarizeToolResult({ success: { content: 'ok' } }), { ok: true, text: 'ok' });
    assert.deepEqual(summarizeToolResult({ success: { stdout: 'out', stderr: 'err' } }), { ok: true, text: 'out\nerr' });
    assert.equal(summarizeToolResult({ error: 'boom' }).ok, false);
    assert.equal(summarizeToolResult({ error: 'boom' }).text, 'boom');
});

test('行切分器只把完整行交出去，半截留着等下一块', () => {
    const lines = [];
    const splitter = createLineSplitter((l) => lines.push(l));
    splitter.push('{"a":1}\n{"b":');
    assert.deepEqual(lines, ['{"a":1}'], '半截 JSON 不能提前交出去');
    splitter.push('2}\n');
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    splitter.push('tail-no-newline');
    splitter.flush();
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', 'tail-no-newline']);
});

// ── runAgentTurn（注入假 spawn，不真的起进程）──────────────────────────────

function fakeSpawn({ lines = [], stderr = '', code = 0, throwOn = null }) {
    const calls = [];
    const spawnFn = (bin, args, opts) => {
        calls.push({ bin, args, opts });
        if (throwOn) throw new Error(throwOn);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stdout.setEncoding = () => {};
        child.stderr = new EventEmitter();
        child.stderr.setEncoding = () => {};
        setImmediate(() => {
            for (const l of lines) child.stdout.emit('data', JSON.stringify(l) + '\n');
            if (stderr) child.stderr.emit('data', stderr);
            child.emit('close', code);
        });
        return child;
    };
    return { spawnFn, calls };
}

test('runAgentTurn 串起完整一轮，回传最终文本与 usage', async () => {
    const { spawnFn, calls } = fakeSpawn({ lines: [INIT, ASSISTANT, TOOL_STARTED, TOOL_COMPLETED, RESULT] });
    const seen = [];

    const out = await runAgentTurn({
        sessionId: 'sid-1', workspace: '/proj', prompt: '读文件',
        agentBin: '/fake/agent', spawnFn, onEvent: (e) => seen.push(e.kind),
    });

    assert.equal(out.ok, true);
    assert.equal(out.text, 'hello.txt 一共有 2 行。');
    assert.equal(out.usage.outputTokens, 87);
    assert.deepEqual(seen, ['init', 'text', 'tool_started', 'tool_completed', 'result']);
    assert.equal(calls[0].bin, '/fake/agent');
});

test('runAgentTurn 强制关掉子 agent 里的 hook 通知，避免同一轮重复发卡', async () => {
    const { spawnFn, calls } = fakeSpawn({ lines: [RESULT] });
    await runAgentTurn({ sessionId: 's', workspace: '/p', prompt: 'x', agentBin: 'agent', spawnFn });

    assert.equal(calls[0].opts.env.CURSOR_NOTIFY_ENABLED, '0');
});

test('没有 result 事件时如实带出 stderr，而不是静默成功', async () => {
    const { spawnFn } = fakeSpawn({ lines: [INIT], stderr: 'Workspace Trust Required', code: 1 });
    const out = await runAgentTurn({ sessionId: 's', workspace: '/p', prompt: 'x', agentBin: 'agent', spawnFn });

    assert.equal(out.ok, false);
    assert.equal(out.isError, true);
    assert.match(out.text, /Workspace Trust Required/);
});

test('spawn 抛错时返回可读原因，不抛给调用方', async () => {
    const { spawnFn } = fakeSpawn({ throwOn: 'ENOENT' });
    const out = await runAgentTurn({ sessionId: 's', workspace: '/p', prompt: 'x', agentBin: 'missing', spawnFn });

    assert.equal(out.ok, false);
    assert.match(out.text, /missing/);
    assert.match(out.text, /ENOENT/);
});

test('onEvent 抛错不会中断本轮（卡片渲染失败不该拖垮会话）', async () => {
    const { spawnFn } = fakeSpawn({ lines: [ASSISTANT, RESULT] });
    const out = await runAgentTurn({
        sessionId: 's', workspace: '/p', prompt: 'x', agentBin: 'agent', spawnFn,
        onEvent: () => { throw new Error('卡片炸了'); },
    });

    assert.equal(out.ok, true);
    assert.equal(out.text, 'hello.txt 一共有 2 行。');
});
