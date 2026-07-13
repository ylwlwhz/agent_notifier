'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSessionLine,
  recoverStateFromContent,
  selectSessionCandidate,
  resolveSessionsRoot,
  isCodexCliProcessArgs,
} = require('../../src/apps/codex-session-watcher');

test('parseSessionLine tracks turn id from turn_context', () => {
  const result = parseSessionLine(
    JSON.stringify({
      type: 'turn_context',
      payload: { turn_id: 'turn-123' },
    }),
    { turnId: '' }
  );

  assert.equal(result.state.turnId, 'turn-123');
  assert.equal(result.entry, null);
});

test('parseSessionLine tracks turn start time from task_started', () => {
  const result = parseSessionLine(
    JSON.stringify({
      timestamp: '2026-04-07T10:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: 'turn-123',
      },
    }),
    { turnId: '', turnStartedAt: null }
  );

  assert.equal(result.state.turnId, 'turn-123');
  assert.equal(result.state.turnStartedAt, '2026-04-07T10:00:00.000Z');
  assert.equal(result.entry, null);
});

test('parseSessionLine tracks latest token_count usage', () => {
  const result = parseSessionLine(
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1234,
            cached_input_tokens: 345,
            output_tokens: 56,
            total_tokens: 1290,
          },
        },
      },
    }),
    { turnId: 'turn-123', tokens: null }
  );

  assert.deepEqual(result.state.tokens, {
    input: 1234,
    cached: 345,
    output: 56,
    total: 1290,
  });
  assert.equal(result.entry, null);
});

test('parseSessionLine emits assistant output_text with current turn id', () => {
  const result = parseSessionLine(
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [
          { type: 'output_text', text: '第一段' },
          { type: 'output_text', text: '第二段' },
        ],
      },
    }),
    {
      turnId: 'turn-abc',
      turnStartedAt: '2026-04-07T10:00:00.000Z',
      tokens: { input: 1234, cached: 345, output: 56, total: 1290 },
    }
  );

  assert.deepEqual(result.entry, {
    text: '第一段\n第二段',
    assistantKey: 'turn-abc',
    icon: '💬',
    phase: 'commentary',
    turnStartedAt: '2026-04-07T10:00:00.000Z',
    tokens: { input: 1234, cached: 345, output: 56, total: 1290 },
  });
});

test('parseSessionLine emits tool step from function_call and keeps call mapping', () => {
  const result = parseSessionLine(
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call_123',
        arguments: JSON.stringify({ cmd: 'rtk git status' }),
      },
    }),
    {
      turnId: 'turn-abc',
      callMap: {},
    }
  );

  assert.equal(result.entry?.assistantKey, 'turn-abc');
  assert.equal(result.entry?.tool, 'exec_command');
  assert.equal(result.entry?.input, 'rtk git status');
  assert.equal(result.entry?.result, null);
  assert.deepEqual(result.state.callMap, {
    call_123: {
      name: 'exec_command',
      input: 'rtk git status',
    },
  });
});

test('parseSessionLine emits tool result from function_call_output', () => {
  const result = parseSessionLine(
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_123',
        output: 'Process exited with code 0\nOutput:\nok',
      },
    }),
    {
      turnId: 'turn-abc',
      callMap: {
        call_123: {
          name: 'exec_command',
          input: 'rtk git status',
        },
      },
    }
  );

  assert.equal(result.entry?.assistantKey, 'turn-abc');
  assert.equal(result.entry?.tool, 'exec_command');
  assert.equal(result.entry?.input, 'rtk git status');
  assert.equal(result.entry?.result, '退出码 0');
  assert.deepEqual(result.state.callMap, {});
});

test('parseSessionLine ignores non assistant response items and event_msg mirror rows', () => {
  const userRow = parseSessionLine(
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    }),
    { turnId: 'turn-abc' }
  );
  assert.equal(userRow.entry, null);

  const mirrorRow = parseSessionLine(
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '镜像事件',
        phase: 'commentary',
      },
    }),
    { turnId: 'turn-abc' }
  );
  assert.equal(mirrorRow.entry, null);
});

test('recoverStateFromContent restores latest turn id from existing session tail', () => {
  const state = recoverStateFromContent([
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-old' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-new' } }),
  ].join('\n'));

  assert.equal(state.turnId, 'turn-new');
});

test('selectSessionCandidate prefers same cwd and closest start time', () => {
  const target = {
    cwd: '/repo/a',
    processStartMs: Date.parse('2026-04-18T07:10:00.000Z'),
  };
  const candidates = [
    {
      path: '/s/1.jsonl',
      mtimeMs: 100,
      meta: { cwd: '/repo/b', timestampMs: Date.parse('2026-04-18T07:10:05.000Z') },
    },
    {
      path: '/s/2.jsonl',
      mtimeMs: 200,
      meta: { cwd: '/repo/a', timestampMs: Date.parse('2026-04-18T07:10:20.000Z') },
    },
    {
      path: '/s/3.jsonl',
      mtimeMs: 300,
      meta: { cwd: '/repo/a', timestampMs: Date.parse('2026-04-18T07:11:30.000Z') },
    },
  ];

  const selected = selectSessionCandidate(candidates, target);
  assert.equal(selected.path, '/s/2.jsonl');
});

test('selectSessionCandidate falls back to newest mtime when no match metadata', () => {
  const selected = selectSessionCandidate(
    [
      { path: '/s/old.jsonl', mtimeMs: 100, meta: null },
      { path: '/s/new.jsonl', mtimeMs: 300, meta: null },
    ],
    { cwd: '/repo/a', processStartMs: Date.now() }
  );
  assert.equal(selected.path, '/s/new.jsonl');
});

test('resolveSessionsRoot uses CODEX_HOME when provided', () => {
  assert.equal(
    resolveSessionsRoot({ codexHome: '/home/u/.tcodex', home: '/home/u' }),
    '/home/u/.tcodex/sessions'
  );
});

test('isCodexCliProcessArgs accepts codex and tcodex process args', () => {
  assert.equal(isCodexCliProcessArgs('/usr/local/bin/codex'), true);
  assert.equal(isCodexCliProcessArgs('/usr/local/bin/tcodex --model gpt-5'), true);
  assert.equal(isCodexCliProcessArgs('node /x/codex-session-watcher.js'), false);
});
