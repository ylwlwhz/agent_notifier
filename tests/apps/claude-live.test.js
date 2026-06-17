'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 置空 FEISHU_LIVE_CAPTURE：使 require 时 main() 立即 return（不读 stdin、不卡住）。
// 用空串而非 delete —— dotenv 不覆盖「已存在」的环境变量，故 .env 里的值不会再灌回来。
process.env.FEISHU_LIVE_CAPTURE = '';

const { buildSummaryCard, buildToolPanel } = require('../../src/apps/claude-live');

const CAPTURE = { tools: true, output: true, results: true };

/** 取卡片里的工具折叠面板（排除段落 narration 面板 `❯ ...`） */
function toolPanels(card) {
  return card.body.elements.filter(e => e.tag === 'collapsible_panel' && !e.header.title.content.startsWith('❯'));
}
function tagText(card) {
  return (card.header.text_tag_list || []).map(t => t.text.content).join(',');
}

test('多行 Bash 命令完整内容进折叠面板，默认折叠（点击查看详细）', () => {
  const seg = { text: '', tools: [{ tool: 'Bash', icon: '⚡', id: 't1', input: 'echo a\necho b\necho c', result: 'r1\nr2' }] };
  const card = buildSummaryCard([seg], 'demo', CAPTURE, null);
  const ps = toolPanels(card);
  assert.equal(ps.length, 1);
  const p = ps[0];
  assert.equal(p.expanded, false, '默认折叠 —— 点击后才展开详细内容');
  const body = JSON.stringify(p.elements);
  assert.ok(body.includes('echo a') && body.includes('echo b') && body.includes('echo c'), '展开应含完整多行命令');
  assert.ok(body.includes('r1') && body.includes('r2'), '展开应含完整结果');
});

test('折叠面板标题只放命令首行预览（单行，防止多行相互重叠）', () => {
  const seg = { text: '', tools: [{ tool: 'Bash', icon: '⚡', id: 't1', input: 'echo a\necho b', result: '' }] };
  const p = toolPanels(buildSummaryCard([seg], 'demo', CAPTURE, null))[0];
  assert.ok(p.header.title.content.includes('echo a'), '标题含首行预览');
  assert.ok(!p.header.title.content.includes('echo b'), '标题不含后续行（防重叠）');
});

test('长命令首行在标题里截断（不撑爆/重叠）', () => {
  const long = 'x'.repeat(200);
  const p = buildToolPanel({ tool: 'Bash', icon: '⚡', input: long, result: '' }, CAPTURE);
  assert.ok(p.header.title.content.length < 80, '标题应截断');
  assert.ok(p.header.title.content.includes('…'), '截断应有省略号');
});

test('多段执行摘要合并到「一张」卡（不再每段一卡），步数累加', () => {
  const segs = [
    { text: '第一步', tools: [{ tool: 'Bash', icon: '⚡', id: 't1', input: 'ls', result: 'ok' }] },
    { text: '第二步', tools: [{ tool: 'Edit', icon: '✏️', id: 't2', input: '编辑 /a/b.js', result: 'done' }] },
  ];
  const card = buildSummaryCard(segs, 'demo', CAPTURE, null);
  const ps = toolPanels(card);
  assert.equal(ps.length, 2, '两段的工具都在同一张卡里');
  assert.ok(ps[0].header.title.content.includes('Bash'));
  assert.ok(ps[1].header.title.content.includes('Edit'));
  assert.equal(tagText(card), '2 步', '步数标签应为两段累加');
});

test('合并模式：保留「已收到」回执 + 蓝色（同执行摘要）+ 标题含已收到（不把已收到卡覆盖没）', () => {
  const seg = { text: '', tools: [{ tool: 'Bash', icon: '⚡', id: 't1', input: 'ls', result: 'ok' }] };
  const card = buildSummaryCard([seg], 'demo', CAPTURE, null, { detail: '**已选择：** 选项甲' });
  assert.equal(card.header.template, 'blue', '合并卡与执行摘要同为蓝色');
  assert.ok(card.header.title.content.includes('已收到'));
  assert.ok(JSON.stringify(card.body.elements).includes('选项甲'), '顶部保留回执');
  assert.ok(toolPanels(card).length === 1, '回执之后仍含工具面板');
});

test('非合并模式：蓝色「执行摘要」，不掺回执', () => {
  const seg = { text: '', tools: [{ tool: 'Bash', icon: '⚡', id: 't1', input: 'ls', result: 'ok' }] };
  const card = buildSummaryCard([seg], 'demo', CAPTURE, null);
  assert.equal(card.header.template, 'blue');
  assert.equal(card.header.title.content, '执行摘要');
  assert.ok(!JSON.stringify(card.body.elements).includes('已收到'));
});
