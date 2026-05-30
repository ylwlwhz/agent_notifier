'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSingleSelectCard, buildQuestionsForm } = require('../../src/lib/feishu-card-utils');

test('buildSingleSelectCard：每个按钮下渲染该选项的提示（description）', () => {
  const q = { header: '方案', question: '选一个', options: [
    { label: '稳妥', description: '改动小、风险低' },
    { label: '激进', description: '一步到位但风险高' },
  ] };
  const card = buildSingleSelectCard(q, 'k', 'tmux:x');
  const md = card.body.elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n');
  assert.match(md, /改动小、风险低/);
  assert.match(md, /一步到位但风险高/);
  // 提示紧跟在对应按钮之后
  const els = card.body.elements;
  const btnIdx = els.findIndex(e => e.tag === 'button' && e.text.content === '稳妥');
  assert.equal(els[btnIdx + 1].tag, 'markdown');
  assert.match(els[btnIdx + 1].content, /改动小/);
});

test('buildQuestionsForm：下拉前以图例展示各选项「标签 — 提示」', () => {
  const questions = [
    { header: '颜色', question: '选色', multiSelect: false, options: [
      { label: '红', description: '热烈' }, { label: '蓝', description: '冷静' },
    ] },
  ];
  const card = buildQuestionsForm(questions, 'k', 'tmux:x');
  const form = card.body.elements.find(e => e.tag === 'form');
  const legend = form.elements.find(e => e.tag === 'markdown' && /热烈/.test(e.content));
  assert.ok(legend, '应有含提示的图例');
  assert.match(legend.content, /\*\*红\*\*/);
  assert.match(legend.content, /冷静/);
});

test('无 description 时不渲染提示/图例（向后兼容）', () => {
  const grey = e => e.tag === 'markdown' && e.content.includes("color='grey'");
  const single = buildSingleSelectCard({ question: 'q', options: [{ label: 'A' }, { label: 'B' }] }, 'k', null);
  assert.ok(!single.body.elements.some(grey));
  const form = buildQuestionsForm([{ question: 'q', multiSelect: false, options: [{ label: 'A' }] }], 'k', null);
  assert.ok(!form.body.elements.find(e => e.tag === 'form').elements.some(grey));
});
