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

test('formatToolInput：子代理/技能/待办等取可读单行，不裸 JSON', () => {
  assert.equal(formatToolInput('Agent', { subagent_type: 'Explore', description: '扫描代码' }), '扫描代码');
  assert.equal(formatToolInput('Skill', { skill: 'update-config', args: 'add x' }), 'update-config add x');
  assert.equal(formatToolInput('SlashCommand', { command: '/review' }), '/review');
  assert.equal(formatToolInput('TodoWrite', { todos: [
    { content: 'A', status: 'completed' },
    { content: '改卡', activeForm: '正在改卡', status: 'in_progress' },
  ] }), '正在改卡');
  assert.equal(formatToolInput('TodoWrite', { todos: [{ content: 'A', status: 'completed' }] }), '1 项待办');
  assert.equal(formatToolInput('KillShell', { shell_id: 'bash_3' }), '终止后台 bash_3');
});

test('buildSegmentCard：每个工具一张折叠面板（非表格）；Bash 展示命令+输出，Edit 展示 diff', () => {
  const seg = { text: '', tools: [
    { tool: 'Bash', icon: '⌘', input: 'git add -A\ngit push', raw: { command: 'git add -A\ngit push' }, result: 'pushed\n2 files' },
    { tool: 'Edit', icon: '📝', input: '编辑 a.js', raw: { file_path: 'a.js', old_string: 'foo', new_string: 'bar' }, result: 'The file a.js has been updated successfully.' },
  ] };
  const card = buildSegmentCard(seg, 'proj', { tools: true, output: true, results: true }, 'tmux:x');

  const panels = card.body.elements.filter(el => el.tag === 'collapsible_panel');
  assert.equal(panels.length, 2);
  assert.ok(!card.body.elements.some(el => el.tag === 'table'), '不应再有 table');

  // Bash：多行命令走代码块，结果在展开区
  assert.match(panels[0].header.title.content, /⌘ Bash/);
  assert.ok(panels[0].elements.some(e => e.content.includes('```bash')), '多行 Bash 命令应有代码块');
  assert.ok(panels[0].elements.some(e => e.content.includes('pushed')), '结果应在展开区');

  // Edit：展开区是 old→new diff（看到真实改动），不展示 "updated successfully" 套话结果
  const editBody = panels[1].elements.map(e => e.content).join('\n');
  assert.match(panels[1].header.title.content, /📝 Edit.*a\.js/);
  assert.match(editBody, /```diff[\s\S]*- foo[\s\S]*\+ bar/);
  assert.ok(!editBody.includes('updated successfully'), '写改类的套话结果应隐藏');
});

test('buildSegmentCard：常规多行内容全文展示，不再砍成 15 行', () => {
  const cmd = Array.from({ length: 40 }, (_, i) => `echo ${i}`).join('\n'); // 40 行远超旧的 15 行硬截
  const seg = { text: '', tools: [{ tool: 'Bash', icon: '⌘', input: 'big', raw: { command: cmd }, result: '' }] };
  const card = buildSegmentCard(seg, 'p', { tools: true, output: true, results: true }, 'tmux:x');
  const body = JSON.stringify(card);
  assert.ok(body.includes('echo 39'), '第 40 行也应在卡内（未被 15 行截断）');
  assert.ok(!body.includes('已截断'), '常规体量不应触发截断提示');
});

test('buildSegmentCard：超 56 字的单行命令/URL，标题截断但正文兜底全文（不丢内容）', () => {
  const longCmd = 'curl -sSL https://example.com/very/long/path?a=1\\&b=2\\&c=3\\&d=4\\&e=5 | jq .data'; // >56 单行
  const longUrl = 'https://example.com/some/really/long/article/path/that/exceeds/fifty-six-characters';
  const seg = { text: '', tools: [
    { tool: 'Bash', icon: '⌘', input: longCmd, raw: { command: longCmd }, result: '' },
    { tool: 'WebFetch', icon: '🌐', input: longUrl, raw: { url: longUrl }, result: '' },
  ] };
  const card = buildSegmentCard(seg, 'p', { tools: true, output: true, results: true }, 'tmux:x');
  const panels = card.body.elements.filter(el => el.tag === 'collapsible_panel');
  // 标题是预览（被截断带省略号），正文兜底完整内容
  assert.ok(panels[0].header.title.content.includes('…'), 'Bash 标题应为截断预览');
  assert.ok(panels[0].elements.some(e => e.content.includes('jq .data')), 'Bash 完整命令应在正文兜底');
  assert.ok(panels[1].elements.some(e => e.content.includes('fifty-six-characters')), 'WebFetch 完整 URL 应在正文兜底');
});

test('buildSegmentCard：病态超大内容回退裁剪到飞书硬上限内，并诚实标注', () => {
  const huge = Array.from({ length: 8000 }, (_, i) => `${i} │ line ${i}`).join('\n'); // ~数百 KB，超 150KB 硬限
  const seg = { text: '', tools: [{ tool: 'Bash', icon: '⌘', input: 'huge', raw: { command: huge }, result: '' }] };
  const card = buildSegmentCard(seg, 'p', { tools: true, output: true, results: true }, 'tmux:x');
  const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8');
  assert.ok(bytes <= 120 * 1024, `整卡应裁到硬上限下，实测 ${bytes} 字节`);
  assert.ok(JSON.stringify(card).includes('已截断，超出飞书单卡'), '裁剪时应诚实标注');
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
