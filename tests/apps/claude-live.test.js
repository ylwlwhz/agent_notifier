'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reconstructSegments, formatToolInput, clipLines, buildSegmentCard, KEY_TOOLS } = require('../../src/apps/claude-live');

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

test('buildSegmentCard：每个工具渲染成折叠面板（非表格），多行命令/结果走代码块', () => {
  const seg = { text: '', tools: [
    { tool: 'Bash', icon: '⚡', input: 'git add -A\ngit push', result: 'pushed\n2 files' },
    { tool: 'Write', icon: '📝', input: '写入 a.js', result: 'File created' },
  ] };
  const card = buildSegmentCard(seg, 'proj', { tools: true, output: true, results: true }, 'tmux:x');

  const panels = card.body.elements.filter(el => el.tag === 'collapsible_panel');
  assert.equal(panels.length, 2);            // 两个工具 → 两张折叠面板，且无 table
  assert.ok(!card.body.elements.some(el => el.tag === 'table'), '不应再有 table');

  // 折叠态标题带图标+工具+命令首行；多行命令在展开区走代码块
  assert.match(panels[0].header.title.content, /⚡ Bash/);
  assert.match(panels[0].header.title.content, /git add -A/);
  assert.ok(panels[0].elements.some(e => e.content.includes('```bash')), '多行 Bash 命令应有代码块');
  assert.ok(panels[0].elements.some(e => e.content.includes('pushed')), '结果应在展开区');

  // 单行命令（Write）标题已含路径，展开区只放结果代码块（不重复命令）
  assert.ok(!panels[1].elements.some(e => e.content.includes('```bash')));
  assert.match(panels[1].header.title.content, /📝 Write.*a\.js/);
});

test('clipLines：保留前 n 行（多行不再只剩第一行），超出补省略号、去尾部空白', () => {
  assert.equal(clipLines('a\nb\nc', 5), 'a\nb\nc');   // 未超 → 原样保留多行
  assert.equal(clipLines('a\nb\nc\nd', 2), 'a\nb\n…'); // 超出 → 截断 + 省略号
  assert.equal(clipLines('only', 5), 'only');
  assert.equal(clipLines('a\nb\n\n', 5), 'a\nb');      // 去尾部空行
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
