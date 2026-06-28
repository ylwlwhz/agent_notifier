'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCard,
  buildExecutionSummaryCard,
  buildLiveSummaryCard,
  computeReadPlan,
  extractOutputPtsNum,
  isCompletionLikeSummary,
} = require('../../src/apps/codex-watcher');

test('computeReadPlan: same file size but newer mtime should re-read whole file', () => {
  const plan = computeReadPlan({
    prevOffset: 4096,
    nextOffset: 4096,
    prevMtimeMs: 1000,
    nextMtimeMs: 1200,
  });

  assert.deepEqual(plan, { shouldRead: true, readOffset: 0, readLength: 4096 });
});

test('computeReadPlan: first-seen file should not replay existing history', () => {
  const plan = computeReadPlan({
    prevOffset: 0,
    nextOffset: 4096,
    prevMtimeMs: 0,
    nextMtimeMs: 1200,
    isFirstSeen: true,
  });

  assert.deepEqual(plan, { shouldRead: false, readOffset: 0, readLength: 0 });
});

test('extractOutputPtsNum: only accepts codex PTY output files', () => {
  assert.equal(extractOutputPtsNum('/tmp/codex-pty-output-61'), '61');
  assert.equal(extractOutputPtsNum('/tmp/claude-pty-output-61'), null);
  assert.equal(extractOutputPtsNum('/tmp/codex-live-61.jsonl'), null);
});

test('isCompletionLikeSummary: detects completion phrases', () => {
  assert.equal(isCompletionLikeSummary('Execution complete. Updated 3 files.'), true);
  assert.equal(isCompletionLikeSummary('任务已完成。'), true);
  assert.equal(isCompletionLikeSummary('Thinking about next steps...'), false);
});

test('live_summary card: blue header and has text input row', () => {
  const card = buildLiveSummaryCard({
    summary: '正在执行：修改 parser 与 watcher',
    cwd: '/home/kamin/work/repo',
    tokens: { input: 1200, output: 88, total: 1288 },
  }, '/dev/pts/1', 'live_key_001');

  assert.equal(card.header.template, 'blue');
  assert.ok(card.header.title.content.includes('执行中'));
  const inputEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'input' && a.value?.action_type === 'text_input')
  );
  assert.ok(inputEl, 'live_summary 应出现 text_input 输入框');
});

// ── execution_summary ────────────────────────────────────────────

test('execution_summary card: green header', () => {
  const card = buildExecutionSummaryCard({
    summary: 'Migration completed successfully.\nAll 12 tests passing.',
    cwd: '/home/kamin/work/repo',
    tokens: { input: 1200, output: 88, total: 1288 },
  }, '/dev/pts/1', 'test_key_001');

  assert.equal(card.header.template, 'green');
});

test('execution_summary card: title uses stable summary label', () => {
  const card = buildExecutionSummaryCard({
    summary: 'Migration completed successfully.\nAll 12 tests passing.',
    cwd: '/home/kamin/work/repo',
    tokens: { input: 1200, output: 88, total: 1288 },
  }, '/dev/pts/1', 'test_key_001');

  assert.ok(card.header.title.content.startsWith('✅'));
  assert.ok(card.header.title.content.includes('执行摘要'));
});

test('execution_summary card: has text input row', () => {
  const card = buildExecutionSummaryCard({
    summary: 'Done.',
    cwd: '/project',
    tokens: { input: 100, output: 50, total: 150 },
  }, '/dev/pts/1', 'test_key_002');

  const inputEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'input' && a.value?.action_type === 'text_input')
  );
  assert.ok(inputEl, 'execution_summary 应出现 text_input 输入框');
});

test('execution_summary card: footer has Codex label, cwd basename, token stats, timestamp', () => {
  const card = buildExecutionSummaryCard({
    summary: 'Done.',
    cwd: '/home/kamin/work/repo',
    tokens: { input: 1200, output: 88, total: 1288 },
  }, '/dev/pts/1', 'test_key_003');

  const footer = card.elements.find(el => el.tag === 'markdown');
  assert.ok(footer, '应有 markdown footer');
  assert.ok(footer.content.includes('🤖 Codex'), '应含 🤖 Codex');
  assert.ok(footer.content.includes('pts/1'), '应含终端编号');
  assert.ok(footer.content.includes('repo'), '应含 cwd basename');
  assert.ok(footer.content.includes('📊'), '应含 token 统计');
  assert.ok(footer.content.includes('⏰'), '应含时间戳');
});

test('execution_summary card: N/A cwd omitted from footer gracefully', () => {
  const card = buildExecutionSummaryCard({
    summary: 'Done.',
    cwd: null,
    tokens: null,
  }, '/dev/pts/2', 'test_key_004');

  const footer = card.elements.find(el => el.tag === 'markdown');
  assert.ok(footer.content.includes('🤖 Codex'));
  // cwd 为 null 时 footer 不含 📁
  assert.ok(!footer.content.includes('📁'), 'cwd 为 null 时不应出现 📁');
});

// ── approval ─────────────────────────────────────────────────────

test('approval card: orange header with ⏸️ 操作确认', () => {
  const card = buildCard(
    { kind: 'approval', question: 'Run npm test?', rawBlock: 'Run npm test? (y/n)' },
    '/dev/pts/3', 'key_001'
  );
  assert.equal(card.header.template, 'orange');
  assert.ok(card.header.title.content.startsWith('⏸️'));
  assert.ok(card.header.title.content.includes('操作确认'));
});

test('approval card: has allow (primary) and deny (danger) buttons', () => {
  const card = buildCard(
    { kind: 'approval', question: 'Run npm test?', rawBlock: 'Run npm test? (y/n)' },
    '/dev/pts/3', 'key_001'
  );
  const actionEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.value?.action_type === 'allow')
  );
  assert.ok(actionEl, '应有 allow 按钮行');
  const allowBtn = actionEl.actions.find(a => a.value?.action_type === 'allow');
  const denyBtn = actionEl.actions.find(a => a.value?.action_type === 'deny');
  assert.ok(allowBtn, '应有 allow 按钮');
  assert.ok(denyBtn, '应有 deny 按钮');
  assert.equal(allowBtn.type, 'primary');
  assert.equal(denyBtn.type, 'danger');
});

test('approval card: has always-present text input row', () => {
  const card = buildCard(
    { kind: 'approval', question: 'Allow?', rawBlock: 'Allow? (y/n)' },
    '/dev/pts/3', 'key_001'
  );
  const inputEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'input' && a.value?.action_type === 'text_input')
  );
  assert.ok(inputEl, '应有通用文字输入框');
});

// ── confirm ───────────────────────────────────────────────────────

test('confirm card: orange header with ⏸️ 操作确认', () => {
  const card = buildCard(
    {
      kind: 'confirm',
      question: 'Continue deployment?',
      options: [{ label: 'Yes', value: '1' }, { label: 'No', value: '2' }],
      rawBlock: 'Continue deployment?\n1. Yes\n2. No',
    },
    '/dev/pts/3', 'key_002'
  );
  assert.equal(card.header.template, 'orange');
  assert.ok(card.header.title.content.includes('操作确认'));
});

test('confirm card: Yes button is primary, No button is danger', () => {
  const card = buildCard(
    {
      kind: 'confirm',
      question: 'Continue deployment?',
      options: [{ label: 'Yes', value: '1' }, { label: 'No', value: '2' }],
      rawBlock: 'Continue deployment?\n1. Yes\n2. No',
    },
    '/dev/pts/3', 'key_002'
  );
  const actionEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'button')
  );
  const buttons = actionEl.actions.filter(a => a.tag === 'button');
  const yesBtn = buttons.find(b => b.text.content === 'Yes');
  const noBtn = buttons.find(b => b.text.content === 'No');
  assert.ok(yesBtn, '应有 Yes 按钮');
  assert.ok(noBtn, '应有 No 按钮');
  assert.equal(yesBtn.type, 'primary');
  assert.equal(noBtn.type, 'danger');
});

test('confirm card: buttons use single_select action_type', () => {
  const card = buildCard(
    {
      kind: 'confirm',
      question: 'Continue?',
      options: [{ label: 'Yes', value: '1' }, { label: 'No', value: '2' }],
      rawBlock: 'Continue?\n1. Yes\n2. No',
    },
    '/dev/pts/3', 'key_002'
  );
  const actionEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'button')
  );
  actionEl.actions.filter(a => a.tag === 'button').forEach(btn => {
    assert.equal(btn.value.action_type, 'single_select');
    assert.ok(btn.value.selected_value, '应有 selected_value');
  });
});

// ── single_select ─────────────────────────────────────────────────

test('single_select card: orange header with ⏸️ 选择方案', () => {
  const card = buildCard(
    {
      kind: 'single_select',
      question: 'Which env?',
      options: [{ label: 'staging', value: '1' }, { label: 'production', value: '2' }],
      rawBlock: 'Which env?\n1. staging\n2. production',
    },
    '/dev/pts/3', 'key_003'
  );
  assert.equal(card.header.template, 'orange');
  assert.ok(card.header.title.content.includes('选择方案'));
});

test('single_select card: first button primary, rest default', () => {
  const card = buildCard(
    {
      kind: 'single_select',
      question: 'Which env?',
      options: [{ label: 'staging', value: '1' }, { label: 'production', value: '2' }],
      rawBlock: 'Which env?\n1. staging\n2. production',
    },
    '/dev/pts/3', 'key_003'
  );
  const actionEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'button')
  );
  const buttons = actionEl.actions.filter(a => a.tag === 'button');
  assert.equal(buttons[0].type, 'primary');
  assert.equal(buttons[1].type, 'default');
  buttons.forEach(b => assert.equal(b.value.action_type, 'single_select'));
});

test('single_select card: letter-value options produce correct button values', () => {
  const card = buildCard(
    {
      kind: 'single_select',
      question: 'Which approach?',
      options: [
        { label: 'Refactor', value: 'A' },
        { label: 'Rewrite', value: 'B' },
      ],
      rawBlock: 'Which approach?\nA. Refactor\nB. Rewrite',
    },
    '/dev/pts/3', 'key_letter_001'
  );
  const actionEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'button')
  );
  const buttons = actionEl.actions.filter(a => a.tag === 'button');
  assert.equal(buttons[0].text.content, 'Refactor');
  assert.equal(buttons[0].value.selected_value, 'A');
  assert.equal(buttons[1].text.content, 'Rewrite');
  assert.equal(buttons[1].value.selected_value, 'B');
});

test('computeReadPlan: truncated file should re-read from beginning', () => {
  const plan = computeReadPlan({
    prevOffset: 8192,
    nextOffset: 2048,
    prevMtimeMs: 1000,
    nextMtimeMs: 1200,
  });
  assert.deepEqual(plan, { shouldRead: true, readOffset: 0, readLength: 2048 });
});

// ── multi_select ──────────────────────────────────────────────────

test('multi_select card: orange header with ⏸️ 多项选择', () => {
  const card = buildCard(
    {
      kind: 'multi_select',
      question: 'Select logs:',
      options: [{ label: 'stdout', value: 'stdout' }, { label: 'stderr', value: 'stderr' }],
      allowFreeText: false,
      rawBlock: 'Select logs:\n[ ] stdout\n[ ] stderr',
    },
    '/dev/pts/3', 'key_004'
  );
  assert.equal(card.header.template, 'orange');
  assert.ok(card.header.title.content.includes('多项选择'));
});

test('multi_select card: option buttons all default type and single_select action_type', () => {
  const card = buildCard(
    {
      kind: 'multi_select',
      question: 'Select logs:',
      options: [{ label: 'stdout', value: 'stdout' }, { label: 'stderr', value: 'stderr' }],
      allowFreeText: false,
      rawBlock: 'Select logs:\n[ ] stdout\n[ ] stderr',
    },
    '/dev/pts/3', 'key_004'
  );
  const actionEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'button')
  );
  const buttons = actionEl.actions.filter(a => a.tag === 'button');
  assert.ok(buttons.length >= 2);
  buttons.forEach(b => {
    assert.equal(b.type, 'default');
    assert.equal(b.value.action_type, 'single_select');
  });
});

test('multi_select card: has dedicated text input for multi-value entry', () => {
  const card = buildCard(
    {
      kind: 'multi_select',
      question: 'Select logs:',
      options: [{ label: 'stdout', value: 'stdout' }],
      allowFreeText: false,
      rawBlock: 'Select logs:\n[ ] stdout',
    },
    '/dev/pts/3', 'key_004'
  );
  const inputs = card.elements.filter(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'input')
  );
  assert.ok(inputs.length >= 1, '应至少有一个输入框');
});

// ── text_input ────────────────────────────────────────────────────

test('text_input card: orange header with 💬 等待输入', () => {
  const card = buildCard(
    { kind: 'text_input', question: 'Enter a label:', rawBlock: 'Enter a label:' },
    '/dev/pts/3', 'key_005'
  );
  assert.equal(card.header.template, 'orange');
  assert.ok(card.header.title.content.startsWith('💬'));
  assert.ok(card.header.title.content.includes('等待输入'));
  const inputEl = card.elements.find(
    el => el.tag === 'action' && el.actions?.some(a => a.tag === 'input' && a.value?.action_type === 'text_input')
  );
  assert.ok(inputEl, '应有输入框');
});

// ── open_question ─────────────────────────────────────────────────

test('open_question card: same style as text_input', () => {
  const card = buildCard(
    { kind: 'open_question', question: 'How to proceed?', rawBlock: 'How to proceed?' },
    '/dev/pts/3', 'key_006'
  );
  assert.equal(card.header.template, 'orange');
  assert.ok(card.header.title.content.startsWith('💬'));
  assert.ok(card.header.title.content.includes('等待输入'));
});

// ── shared: footer ────────────────────────────────────────────────

test('all prompt cards: footer contains 🤖 Codex and terminal', () => {
  const cases = [
    { kind: 'approval', question: 'Q?', rawBlock: 'Q?' },
    { kind: 'confirm', question: 'Q?', options: [{ label: 'Yes', value: '1' }], rawBlock: 'Q?\n1. Yes' },
    { kind: 'single_select', question: 'Q?', options: [{ label: 'opt', value: '1' }], rawBlock: 'Q?\n1. opt' },
    { kind: 'multi_select', question: 'Q?', options: [{ label: 'a', value: 'a' }], rawBlock: 'Q?\n[ ] a' },
    { kind: 'text_input', question: 'Q?', rawBlock: 'Q?' },
    { kind: 'open_question', question: 'Q?', rawBlock: 'Q?' },
  ];
  for (const parsed of cases) {
    const card = buildCard(parsed, '/dev/pts/9', 'key_shared');
    const footer = card.elements.find(el => el.tag === 'markdown');
    assert.ok(footer, `${parsed.kind}: 应有 footer`);
    assert.ok(footer.content.includes('🤖 Codex'), `${parsed.kind}: footer 应含 🤖 Codex`);
    assert.ok(footer.content.includes('pts/9'), `${parsed.kind}: footer 应含终端编号`);
    assert.ok(footer.content.includes('⏰'), `${parsed.kind}: footer 应含时间戳`);
  }
});
