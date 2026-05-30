'use strict';

/**
 * AskUserQuestion 回放规划器单测（纯函数，单选/多选/多题/自定义统一覆盖）。
 * 键序对照 Claude Code 2.1.158 真机实测模型，详见 src/lib/askq-replay.js 顶部注释。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReplayPlan, firstUnanswered, selectedIndices } = require('../../src/lib/askq-replay');

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const RIGHT = '\x1b[C';
const ENTER = '\r';
const keysOf = (plan) => plan.map(s => (
  s.keys != null ? { keys: s.keys }
    : s.multiCustom != null ? { multiCustom: s.multiCustom }
      : { text: s.text, submit: !!s.submit }
));

test('单题单选：Down×idx + Enter，无 Submit tab 收尾', () => {
  const plan = buildReplayPlan([{ multiSelect: false, optionCount: 3 }], { q0: '2' });
  assert.deepEqual(keysOf(plan), [{ keys: DOWN.repeat(2) }, { keys: ENTER }]);
});

test('单题单选默认第一项：仅 Enter', () => {
  const plan = buildReplayPlan([{ multiSelect: false, optionCount: 3 }], { q0: '0' });
  assert.deepEqual(keysOf(plan), [{ keys: ENTER }]);
});

test('单题单选自定义：Down×len 到 Type something + 打字回车，无收尾', () => {
  const plan = buildReplayPlan([{ multiSelect: false, optionCount: 3 }], { q0_other: '自定义答案' });
  assert.deepEqual(keysOf(plan), [
    { keys: DOWN.repeat(3) },
    { text: '自定义答案', submit: true },
  ]);
});

test('单题单选自定义优先于下拉选项', () => {
  const plan = buildReplayPlan([{ multiSelect: false, optionCount: 3 }], { q0: '1', q0_other: '自定义' });
  assert.deepEqual(keysOf(plan), [{ keys: DOWN.repeat(3) }, { text: '自定义', submit: true }]);
});

test('单题多选：逐个切勾选 + RIGHT 切 Submit tab + 末尾 Enter', () => {
  const plan = buildReplayPlan([{ multiSelect: true, optionCount: 3 }], { q0: ['0', '2'] });
  assert.deepEqual(keysOf(plan), [
    { keys: ENTER },          // 勾 idx0
    { keys: DOWN.repeat(2) }, // 到 idx2
    { keys: ENTER },          // 勾 idx2
    { keys: RIGHT },          // 切到 Submit tab
    { keys: ENTER },          // Submit answers
  ]);
});

test('多题混合的精确键序', () => {
  const plan = buildReplayPlan(
    [{ multiSelect: false, optionCount: 3 }, { multiSelect: true, optionCount: 3 }],
    { q0: '2', q1: ['1', '2'] },
  );
  assert.deepEqual(keysOf(plan), [
    { keys: DOWN.repeat(2) }, { keys: ENTER }, // Q0 单选 idx2
    { keys: DOWN }, { keys: ENTER },           // Q1 到 idx1、勾选
    { keys: DOWN }, { keys: ENTER },           // Q1 到 idx2、勾选
    { keys: RIGHT },                           // 切 Submit tab
    { keys: ENTER },                           // Submit answers
  ]);
});

test('多选自定义：勾选 + 文本哨兵(multiCustom) + 退输入态回普通行 + 切 tab', () => {
  const plan = buildReplayPlan([{ multiSelect: true, optionCount: 3 }], { q0: ['0'], q0_other: '芒果' });
  assert.deepEqual(keysOf(plan), [
    { keys: ENTER },                            // 勾 idx0
    { keys: DOWN.repeat(3) },                   // 到 Type something（第 len 项）
    { multiCustom: '芒果' },                        // 文本 + 空格哨兵
    { keys: DOWN }, { keys: UP }, { keys: UP },  // 退输入态回普通选项行
    { keys: RIGHT }, { keys: ENTER },            // 切 tab + Submit answers
  ]);
});

test('多选纯自定义（无勾选）也走 multiCustom', () => {
  const plan = buildReplayPlan([{ multiSelect: true, optionCount: 3 }], { q0_other: '葡萄' });
  assert.deepEqual(keysOf(plan), [
    { keys: DOWN.repeat(3) }, { multiCustom: '葡萄' },
    { keys: DOWN }, { keys: UP }, { keys: UP },
    { keys: RIGHT }, { keys: ENTER },
  ]);
});

test('selectedIndices：去非法、去重排序', () => {
  assert.deepEqual(selectedIndices({ q0: ['2', '0', '9', '-1'] }, 0, 3, true), [0, 2]);
  assert.deepEqual(selectedIndices({ q0: '1' }, 0, 3, false), [1]);
  assert.deepEqual(selectedIndices({}, 0, 3, false), []);
});

test('firstUnanswered：单选未答 / 多选未勾 / 自定义算已答', () => {
  const qs = [{ multiSelect: false, optionCount: 2 }, { multiSelect: true, optionCount: 2 }];
  assert.equal(firstUnanswered({ q0: '0', q1: ['1'] }, qs), -1);          // 全答
  assert.equal(firstUnanswered({ q1: ['1'] }, qs), 0);                    // Q0 单选未答
  assert.equal(firstUnanswered({ q0: '0' }, qs), 1);                      // Q1 多选未勾
  assert.equal(firstUnanswered({ q0_other: 'x', q1: ['0'] }, qs), -1);    // 单选自定义算已答
  assert.equal(firstUnanswered({ q0: '0', q1_other: 'x' }, qs), -1);      // 多选自定义也算已答
});
