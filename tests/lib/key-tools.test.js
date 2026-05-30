'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KEY_TOOLS } = require('../../src/lib/key-tools');
const live = require('../../src/apps/claude-live');

test('KEY_TOOLS 含写改/联网/子代理/技能/待办/计划·进程控制，不含高频纯读与问卷卡', () => {
  for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch',
                   'Agent', 'Task', 'Skill', 'SlashCommand', 'TodoWrite', 'ExitPlanMode', 'KillShell', 'BashOutput']) {
    assert.ok(KEY_TOOLS.has(t), `应含 ${t}`);
  }
  for (const t of ['Read', 'Grep', 'Glob', 'AskUserQuestion']) {
    assert.ok(!KEY_TOOLS.has(t), `不应含 ${t}`);
  }
});

test('claude-live 复用同一个 KEY_TOOLS 实例（单一事实源，防 live/Stop 工具集漂移）', () => {
  assert.equal(live.KEY_TOOLS, KEY_TOOLS);
});
