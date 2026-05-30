'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KEY_TOOLS } = require('../../src/lib/key-tools');
const live = require('../../src/apps/claude-live');

test('KEY_TOOLS 含有副作用/对外动作的工具，不含纯只读', () => {
  for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch']) {
    assert.ok(KEY_TOOLS.has(t), `应含 ${t}`);
  }
  for (const t of ['Read', 'Grep', 'Glob']) {
    assert.ok(!KEY_TOOLS.has(t), `不应含 ${t}（纯只读，避免刷屏）`);
  }
});

test('claude-live 复用同一个 KEY_TOOLS 实例（单一事实源，防 live/Stop 工具集漂移）', () => {
  assert.equal(live.KEY_TOOLS, KEY_TOOLS);
});
