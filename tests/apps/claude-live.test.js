'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reconstructSegments, formatToolInput, KEY_TOOLS } = require('../../src/apps/claude-live');

/** 把若干 transcript 行写到临时 jsonl，返回路径 */
function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `live-test-${process.pid}-${lines.length}-${Math.floor(performance.now())}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n'), 'utf8');
  return p;
}

test('WebSearch / WebFetch 已纳入触发并展示的工具集', () => {
  assert.ok(KEY_TOOLS.has('WebSearch'));
  assert.ok(KEY_TOOLS.has('WebFetch'));
});

test('formatToolInput：web 工具取 query / url', () => {
  assert.equal(formatToolInput('WebSearch', { query: 'cats' }), 'cats');
  assert.equal(formatToolInput('WebFetch', { url: 'https://x.com' }), 'https://x.com');
});

test('reconstructSegments：连续文字合并入同段、web 工具入表、结果回填', () => {
  const p = writeTranscript([
    { type: 'user', message: { content: '去查点东西' }, timestamp: '2024-01-01T00:00:00Z' },
    { type: 'assistant', message: { content: [
      { type: 'text', text: '先说第一段' },
      { type: 'text', text: '再说第二段' },
      { type: 'tool_use', name: 'WebSearch', input: { query: 'cats' }, id: 't1' },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '搜到了' }] } },
    { type: 'assistant', message: { content: [
      { type: 'text', text: '第三段' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 't2' },
    ] } },
  ]);
  const { segments } = reconstructSegments(p);
  fs.unlinkSync(p);

  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, '先说第一段\n\n再说第二段'); // 不吞文字
  assert.equal(segments[0].tools[0].tool, 'WebSearch');
  assert.equal(segments[0].tools[0].input, 'cats');
  assert.equal(segments[0].tools[0].result, '搜到了');
  assert.equal(segments[1].text, '第三段');
  assert.equal(segments[1].tools[0].tool, 'Bash');
});

test('reconstructSegments：未捕获工具(Read)前后的文字不被吞，归入后续工具段', () => {
  const p = writeTranscript([
    { type: 'user', message: { content: 'go' }, timestamp: '2024-01-01T00:00:00Z' },
    { type: 'assistant', message: { content: [
      { type: 'text', text: '解释一下' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'x' }, id: 'r1' }, // 非 KEY_TOOL，不捕获
      { type: 'text', text: '继续解释' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'b1' },
    ] } },
  ]);
  const { segments } = reconstructSegments(p);
  fs.unlinkSync(p);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, '解释一下\n\n继续解释');
  assert.equal(segments[0].tools.length, 1);
  assert.equal(segments[0].tools[0].tool, 'Bash');
});
