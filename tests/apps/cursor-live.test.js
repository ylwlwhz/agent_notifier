'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../../src/apps/cursor-live');

test('parseCaptureConfig 与 claude/codex 同语义', () => {
    const prev = process.env.FEISHU_LIVE_CAPTURE;
    try {
        delete process.env.FEISHU_LIVE_CAPTURE;
        assert.equal(live.parseCaptureConfig(), null);

        process.env.FEISHU_LIVE_CAPTURE = '1';
        assert.deepEqual(live.parseCaptureConfig(), { tools: true, output: true, results: true });

        process.env.FEISHU_LIVE_CAPTURE = 'true';
        assert.deepEqual(live.parseCaptureConfig(), { tools: true, output: true, results: true });

        process.env.FEISHU_LIVE_CAPTURE = 'tools,results';
        assert.deepEqual(live.parseCaptureConfig(), { tools: true, output: false, results: true });
    } finally {
        if (prev === undefined) delete process.env.FEISHU_LIVE_CAPTURE;
        else process.env.FEISHU_LIVE_CAPTURE = prev;
    }
});

test('buildSegments：一段文字带起其后的工具', () => {
    const segments = live.buildSegments([
        { type: 'text', text: '先看下测试' },
        { type: 'tool', tool: 'Shell', icon: '⚡', input: 'npm test', result: 'ok' },
        { type: 'tool', tool: 'Write', icon: '📝', input: 'src/a.ts' },
        { type: 'text', text: '再改一处' },
        { type: 'tool', tool: 'StrReplace', icon: '✏️', input: 'src/b.ts' },
    ]);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].text, '先看下测试');
    assert.deepEqual(segments[0].tools.map((t) => t.tool), ['Shell', 'Write']);
    assert.equal(segments[1].text, '再改一处');
    assert.deepEqual(segments[1].tools.map((t) => t.tool), ['StrReplace']);
});

test('buildSegments 透传失败标记：失败没有独立卡片了，标记丢了就等于失败被吞掉', () => {
    const segments = live.buildSegments([
        { type: 'tool', tool: 'Shell', icon: '⚡', input: 'npm run e2e', result: '超时', failed: true, failureReason: '执行超时' },
        { type: 'tool', tool: 'Read', icon: '📖', input: 'src/a.ts', result: 'ok' },
    ]);

    assert.deepEqual(segments[0].tools.map((t) => t.failed), [true, false]);
    assert.equal(segments[0].tools[0].failureReason, '执行超时');
});

test('buildSegments：开头就是工具时补一个无文字段，不丢步骤', () => {
    const segments = live.buildSegments([
        { type: 'tool', tool: 'Shell', icon: '⚡', input: 'ls' },
    ]);

    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, '');
    assert.equal(segments[0].tools.length, 1);
});

test('buildSegments 忽略脏行，不因一条坏数据整轮失败', () => {
    const segments = live.buildSegments([
        null,
        { type: 'unknown' },
        { type: 'tool', tool: 'Shell', icon: '⚡', input: 'ls' },
    ]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].tools.length, 1);
});

test('轮次边界由 generation_id 决定：同轮 patch，新轮新发', () => {
    assert.equal(live.shouldCreateNewCard(null, 'gen-1'), true, '没有旧卡就新发');
    assert.equal(live.shouldCreateNewCard({ generationId: 'gen-1' }, 'gen-1'), true,
        '有 generationId 但没 message_id 也要新发');
    assert.equal(live.shouldCreateNewCard({ message_id: 'm1', generationId: 'gen-1' }, 'gen-1'), false);
    assert.equal(live.shouldCreateNewCard({ message_id: 'm1', generationId: 'gen-1' }, 'gen-2'), true);
});

test('同轮 flush 会接上历史步骤，patch 不会把前面的步骤覆盖没', () => {
    const existing = {
        message_id: 'm1',
        generationId: 'gen-1',
        entries: [{ type: 'tool', tool: 'Shell', input: 'step1' }],
    };
    const merged = live.mergeTurnEntries(existing, [{ type: 'tool', tool: 'Shell', input: 'step2' }], 'gen-1');
    assert.deepEqual(merged.map((e) => e.input), ['step1', 'step2']);
});

test('新轮从零开始，不把上一轮的步骤带进来', () => {
    const existing = {
        message_id: 'm1',
        generationId: 'gen-1',
        entries: [{ type: 'tool', tool: 'Shell', input: 'old' }],
    };
    const merged = live.mergeTurnEntries(existing, [{ type: 'tool', tool: 'Shell', input: 'new' }], 'gen-2');
    assert.deepEqual(merged.map((e) => e.input), ['new']);
});

test('单轮步骤数有上限：state 是多进程共享账本，不能无限长', () => {
    const existing = {
        message_id: 'm1',
        generationId: 'gen-1',
        entries: Array.from({ length: live.MAX_TURN_ENTRIES }, (_, i) => ({ type: 'tool', input: `s${i}` })),
    };
    const merged = live.mergeTurnEntries(existing, [{ type: 'tool', input: 'newest' }], 'gen-1');

    assert.equal(merged.length, live.MAX_TURN_ENTRIES);
    assert.equal(merged[merged.length - 1].input, 'newest');
    assert.equal(merged[0].input, 's1', '丢的是最旧的');
});

test('缓冲文件名可还原会话键', () => {
    assert.equal(live.sessionKeyFromBuffer('/tmp/cursor-live-conv-9f8.jsonl'), 'conv-9f8');
});

test('require 本模块不产生副作用（cursor-hook 要复用 parseCaptureConfig）', () => {
    assert.equal(typeof live.flushBuffer, 'function');
    assert.equal(typeof live.parseCaptureConfig, 'function');
});
