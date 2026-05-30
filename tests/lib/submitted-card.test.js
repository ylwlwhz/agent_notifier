'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSubmittedCard } = require('../../src/lib/feishu-card-utils');

const QS = [
  { header: 'Pick color', options: ['Red', 'Green'], optionCount: 2, multiSelect: false },
  { header: 'Pick toppings', options: ['Cheese', 'Mushroom', 'Onion'], optionCount: 3, multiSelect: true },
];

function bodyText(card) {
  return card.body.elements.find(el => el.tag === 'markdown').content;
}

test('buildSubmittedCard：回显单选 + 多选 + 自定义，绿卡 + 终端 id 灰字', () => {
  const card = buildSubmittedCard(QS, { q0: '0', q1: ['0', '1'], q1_other: 'Bacon' }, 'tmux:myproj');
  assert.equal(card.header.template, 'green');
  assert.equal(bodyText(card), '**Pick color**　Red\n**Pick toppings**　Cheese、Mushroom、Bacon');
  const foot = card.body.elements[card.body.elements.length - 1];
  assert.match(foot.content, /myproj/);
});

test('buildSubmittedCard：单选自定义（只有 q0_other）', () => {
  const card = buildSubmittedCard([QS[0]], { q0_other: '12345' }, 'tmux:p');
  assert.equal(bodyText(card), '**Pick color**　12345');
});

test('buildSubmittedCard：未选未填回显占位符，不崩', () => {
  const card = buildSubmittedCard([QS[0]], {}, null);
  assert.equal(bodyText(card), '**Pick color**　—');
});
