'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sendQuestionsForm } = require('../../src/apps/claude-ask');
const { sessionState } = require('../../src/lib/session-state');

function fakeApp(sent) {
  return {
    chatId: 'chat-1',
    client: { im: { message: { create: async ({ data }) => { sent.push(JSON.parse(data.content)); return { data: { message_id: 'msg-1' } }; } } } },
  };
}

test('sendQuestionsForm：单题/多题统一发一张 form 卡，并存回放元数据', async () => {
  const sent = [];
  await sendQuestionsForm(
    fakeApp(sent),
    [
      { header: '方案', question: '选哪个？', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
      { header: '水果', question: '吃啥？', multiSelect: true, options: [{ label: '苹果' }, { label: '梨' }, { label: '桃' }] },
    ],
    'state-form', 'fifo:/tmp/agent-inject-pts7', 'session-1', 'AskUserQuestion',
  );

  assert.equal(sent.length, 1);
  const card = sent[0];

  // 单 form 容器，含两题的选择器 + 提交按钮
  const form = card.body.elements.find(el => el.tag === 'form');
  assert.ok(form, '应有 form 容器');
  const tags = form.elements.map(el => el.tag);
  assert.ok(tags.includes('select_static'), '单选题用 select_static');
  assert.ok(tags.includes('multi_select_static'), '多选题用 multi_select_static');
  const submit = form.elements.find(el => el.tag === 'button');
  assert.equal(submit.value.action_type, 'submit_questions');

  // 每题都带自定义输入框（单选/多选自定义均已可靠）
  const inputs = form.elements.filter(el => el.tag === 'input');
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map(i => i.name), ['q0_other', 'q1_other']);

  // 存了回放所需的精简元数据
  const notif = sessionState.getNotification('state-form');
  assert.equal(notif._questions_form, true);
  assert.deepEqual(notif._questions, [
    { multiSelect: false, optionCount: 2 },
    { multiSelect: true, optionCount: 3 },
  ]);
  sessionState.removeNotification('state-form');
});
