'use strict';

/**
 * Cursor CLI 会话：排队语义、增量分段、卡片生命周期。
 *
 * 这条链路的价值就是「随时能回」，所以测试重点是：执行中收到的指令不能丢、
 * 不能并发跑两轮、异常后会话不能永久卡死。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cli-test-'));
process.env.AGENT_NOTIFIER_STATE = path.join(TMP, 'state.json');

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionState } = require('../../src/lib/session-state');
const cursorCli = require('../../src/apps/cursor-cli');
const cards = require('../../src/apps/cursor-cards');

function freshState() {
    return new SessionState(path.join(TMP, `state-${Math.random().toString(36).slice(2)}.json`));
}

// ── 分段累积 ────────────────────────────────────────────────────────────────

test('增量分段：文字起段，工具挂在当前段下', () => {
    const acc = cursorCli.createSegmentAccumulator();
    acc.add({ kind: 'text', text: '先读文件' });
    acc.add({ kind: 'tool_started', callId: 'c1', tool: 'Read', icon: '📖', input: '/a.ts' });
    acc.add({ kind: 'tool_completed', callId: 'c1', tool: 'Read', ok: true, result: '内容' });
    acc.add({ kind: 'text', text: '再改一处' });
    acc.add({ kind: 'tool_started', callId: 'c2', tool: 'Write', icon: '📝', input: '/b.ts' });

    assert.equal(acc.segments.length, 2);
    assert.equal(acc.segments[0].text, '先读文件');
    assert.equal(acc.segments[0].tools[0].result, '内容', 'completed 必须回填到 started 那一条');
    assert.equal(acc.segments[1].tools[0].tool, 'Write');
});

test('工具先于任何文字出现时补一个无文字段，不丢步骤', () => {
    const acc = cursorCli.createSegmentAccumulator();
    acc.add({ kind: 'tool_started', callId: 'c1', tool: 'Shell', icon: '⚡', input: 'ls' });

    assert.equal(acc.segments.length, 1);
    assert.equal(acc.segments[0].text, '');
    assert.equal(acc.segments[0].tools.length, 1);
});

test('completed 配不上 started 时补录，不静默丢弃', () => {
    const acc = cursorCli.createSegmentAccumulator();
    acc.add({ kind: 'tool_completed', callId: 'orphan', tool: 'Shell', icon: '⚡', input: 'ls', ok: false, result: 'boom' });

    assert.equal(acc.segments[0].tools.length, 1);
    assert.equal(acc.segments[0].tools[0].result, 'boom');
});

// ── 排队语义 ────────────────────────────────────────────────────────────────

test('空闲时接指令 → 由本次开跑', async () => {
    const state = freshState();
    const { stateKey } = await cursorCli.createSession({ state, workspace: '/proj', chatId: 'c' });

    const r = await cursorCli.acceptPrompt({ state, stateKey, prompt: 'a' });
    assert.deepEqual(r, { started: true, queued: false });
    assert.equal(state.getNotification(stateKey).running, true);
});

test('执行中接指令 → 排队而不是并发跑两轮', async () => {
    const state = freshState();
    const { stateKey } = await cursorCli.createSession({ state, workspace: '/proj', chatId: 'c' });
    await cursorCli.acceptPrompt({ state, stateKey, prompt: 'a' });

    const second = await cursorCli.acceptPrompt({ state, stateKey, prompt: 'b' });
    const third = await cursorCli.acceptPrompt({ state, stateKey, prompt: 'c' });

    assert.deepEqual(second, { started: false, queued: true, depth: 1 });
    assert.deepEqual(third, { started: false, queued: true, depth: 2 });
    assert.deepEqual(state.getNotification(stateKey).queue, ['b', 'c']);
});

test('排队按先进先出取出，取空后释放 running', async () => {
    const state = freshState();
    const { stateKey } = await cursorCli.createSession({ state, workspace: '/proj', chatId: 'c' });
    await cursorCli.acceptPrompt({ state, stateKey, prompt: 'a' });
    await cursorCli.acceptPrompt({ state, stateKey, prompt: 'b' });
    await cursorCli.acceptPrompt({ state, stateKey, prompt: 'c' });

    assert.equal(await cursorCli.takeNextPrompt({ state, stateKey }), 'b');
    assert.equal(await cursorCli.takeNextPrompt({ state, stateKey }), 'c');
    assert.equal(await cursorCli.takeNextPrompt({ state, stateKey }), null);
    assert.equal(state.getNotification(stateKey).running, false, '队列空了必须放掉 running');
});

test('会话不存在时如实报 missing，不去凭空建一个', async () => {
    const state = freshState();
    const r = await cursorCli.acceptPrompt({ state, stateKey: 'cursor_cli_nope', prompt: 'x' });
    assert.equal(r.missing, true);
});

test('接指令会给会话续命，长期使用的会话不被过期清理掉', async () => {
    const state = freshState();
    const { stateKey } = await cursorCli.createSession({ state, workspace: '/proj', chatId: 'c' });
    await state.mutateAsync((d) => { d[stateKey].created_at = 1; });

    await cursorCli.acceptPrompt({ state, stateKey, prompt: 'x' });
    assert.ok(state.getNotification(stateKey).created_at > 1e12, 'created_at 应被刷新');
});

test('会话记录形态：无 pts_device，带 cli_session_id', async () => {
    const state = freshState();
    const { stateKey, record } = await cursorCli.createSession({ state, workspace: '/tmp/demo', chatId: 'chat-1' });

    assert.match(stateKey, /^cursor_cli_/);
    assert.equal(record.host, 'cursor');
    assert.equal(record.notification_type, 'cursor_cli_session');
    assert.equal(record.pts_device, null, 'Cursor 没有终端可注入');
    assert.match(record.cli_session_id, /^[0-9a-f-]{36}$/);
    assert.equal(record.project_name, 'demo');
});

// ── 一轮的卡片生命周期 ──────────────────────────────────────────────────────

test('一轮一张卡：开跑蓝卡、结束定稿为绿色完成卡，两态都留输入框', async () => {
    const state = freshState();
    const { stateKey } = await cursorCli.createSession({ state, workspace: '/proj', chatId: 'chat-1' });

    const running = cards.buildCliTurnCard({
        segments: [{ text: '干活中', tools: [{ tool: 'Shell', icon: '⚡', input: 'ls', result: '' }] }],
        status: 'running', stateKey, projectName: 'proj',
    });
    const done = cards.buildCliTurnCard({
        segments: [{ text: '干完了', tools: [] }],
        status: 'done', stateKey, projectName: 'proj',
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 },
        durationMs: 12000,
    });

    assert.equal(running.header.template, 'blue');
    assert.equal(done.header.template, 'green');

    const inputs = (card) => JSON.stringify(card).match(/"tag":"input"/g) || [];
    assert.equal(inputs(running).length, 1, '执行中也要有输入框：消息会排队');
    assert.equal(inputs(done).length, 1, '完成后当然要有输入框');

    const footer = JSON.stringify(done);
    assert.match(footer, /🤖 Cursor/);
    assert.match(footer, /12s/);
    assert.match(footer, /输入 100/);
});

test('执行中卡片显示排队条数，用户知道自己的指令没丢', () => {
    const card = cards.buildCliTurnCard({
        segments: [], status: 'running', stateKey: 'k', projectName: 'p', queued: 2,
    });
    assert.match(JSON.stringify(card), /已排队 2 条/);
});

test('出错时是红卡', () => {
    const card = cards.buildCliTurnCard({ segments: [], status: 'error', stateKey: 'k', projectName: 'p' });
    assert.equal(card.header.template, 'red');
});

test('就绪卡告诉用户可以随时回话', () => {
    const card = cards.buildCliTurnCard({ segments: [], status: 'ready', stateKey: 'k', projectName: 'p' });
    assert.equal(card.header.template, 'indigo');
    assert.match(JSON.stringify(card), /任何时候都能继续回话/);
});

test('CLI usage 字段被正确映射到 footer 的 token 统计', () => {
    assert.deepEqual(
        cards.cliTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
        { input: 1, output: 2, cached: 3, cacheWrite: 4 }
    );
    assert.equal(cards.cliTokens(null), null);
});

test('项目菜单：每个项目一个按钮 + 手填路径输入框', () => {
    const card = cards.buildCliLaunchMenu({ projects: ['a', 'b'], stateKey: 'k', rootDir: '/root' });
    const json = JSON.stringify(card);

    assert.match(json, /"action_type":"opt_0"/);
    assert.match(json, /"action_type":"opt_1"/);
    assert.match(json, /cursor_launch_path/);

    const empty = cards.buildCliLaunchMenu({ projects: [], stateKey: 'k', rootDir: '/root' });
    assert.match(JSON.stringify(empty), /\/root/);
});
