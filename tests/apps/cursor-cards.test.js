'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { translateCursorHook } = require('../../src/adapters/cursor/hook-adapter');
const cards = require('../../src/apps/cursor-cards');

const shellFixture = require('../fixtures/cursor/before-shell-execution.json');
const stopFixture = require('../fixtures/cursor/stop.json');
const failureFixture = require('../fixtures/cursor/post-tool-use-failure.json');

/** 递归收集所有 tag 为 target 的元素（卡片是嵌套结构，不能只看顶层） */
function collect(node, target, found = []) {
    if (Array.isArray(node)) {
        node.forEach((item) => collect(item, target, found));
        return found;
    }
    if (!node || typeof node !== 'object') return found;
    if (node.tag === target) found.push(node);
    Object.values(node).forEach((value) => collect(value, target, found));
    return found;
}

function footerText(card) {
    const markdowns = collect(card.body.elements, 'markdown');
    return markdowns.map((el) => el.content).find((c) => c.includes('🤖 Cursor')) || '';
}

test('审批卡：允许/拒绝/本地确认三个按钮 + 输入框 + 宿主 footer', () => {
    const event = translateCursorHook(shellFixture);
    const card = cards.buildApprovalCard({ event, stateKey: 'k1', timeoutMs: 180000 });

    const buttons = collect(card.body.elements, 'button');
    assert.deepEqual(
        buttons.map((b) => b.value.action_type),
        ['allow', 'deny', 'local']
    );
    assert.ok(buttons.every((b) => b.value.session_state_key === 'k1'));

    const inputs = collect(card.body.elements, 'input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].value.action_type, 'text_input');

    assert.equal(card.header.template, 'orange');
    assert.match(card.header.title.content, /权限确认 · Cursor/);

    const footer = footerText(card);
    assert.match(footer, /🤖 Cursor/);
    assert.match(footer, /🧠 claude-opus-5/);
    assert.match(footer, /📁 agent_notifier/);
});

test('审批卡把超时后的去向写在卡上，避免用户以为点了没用', () => {
    const event = translateCursorHook(shellFixture);
    const card = cards.buildApprovalCard({ event, stateKey: 'k1', timeoutMs: 90000 });
    const hint = collect(card.body.elements, 'markdown').map((e) => e.content).join('\n');

    assert.match(hint, /90 秒/);
    assert.match(hint, /回落到 Cursor 本地弹窗/);
});

test('等待窗口按人话写：12 小时不能渲染成 43200s，那没人读得懂', () => {
    assert.equal(cards.humanWindow(90 * 1000), '90 秒');
    assert.equal(cards.humanWindow(180 * 1000), '3 分钟');
    assert.equal(cards.humanWindow(43200 * 1000), '12 小时');
    assert.equal(cards.humanWindow(86400 * 1000), '24 小时');
    assert.equal(cards.humanWindow(5400 * 1000), '1.5 小时');
});

test('审批卡回调映射：允许=allow，拒绝会把理由带给 agent', () => {
    const responses = cards.approvalResponses();

    assert.deepEqual(responses.allow.decision, { permission: 'allow' });
    assert.equal(responses.deny.decision.permission, 'deny');
    assert.match(responses.deny.decision.agent_message, /拒绝/);
    assert.equal(responses.local.decision.permission, 'ask');

    // 必须是可变副本：cursor-hook 会把它整体写进 sessionState
    responses.allow.label = 'mutated';
    assert.notEqual(cards.approvalResponses().allow.label, 'mutated');
});

test('完成卡（等待续写）：带输入框与结束按钮，标签提示正在等', () => {
    const event = translateCursorHook(stopFixture);
    const card = cards.buildFollowupCard({
        event, stateKey: 'k2', body: '已完成重构', timeoutMs: 300000, waiting: true,
    });

    assert.equal(card.header.template, 'green');
    assert.match(card.header.title.content, /Cursor 完成/);
    assert.deepEqual(card.header.text_tag_list.map((t) => t.text.content), ['等待续写']);

    assert.equal(collect(card.body.elements, 'input').length, 1);
    assert.deepEqual(
        collect(card.body.elements, 'button').map((b) => b.value.action_type),
        ['stop_now']
    );
});

test('完成卡（纯通知）：不放任何交互组件，点了也没人接的组件不该出现', () => {
    const event = translateCursorHook(stopFixture);
    const card = cards.buildFollowupCard({
        event, stateKey: null, body: '已完成重构', timeoutMs: 0, waiting: false,
    });

    assert.equal(collect(card.body.elements, 'input').length, 0);
    assert.equal(collect(card.body.elements, 'button').length, 0);
    assert.match(footerText(card), /🤖 Cursor/);
});

test('完成卡按 status 换配色：error 红、aborted 灰', () => {
    const err = translateCursorHook({ ...stopFixture, status: 'error' });
    const aborted = translateCursorHook({ ...stopFixture, status: 'aborted' });

    assert.equal(cards.buildFollowupCard({ event: err, waiting: false }).header.template, 'red');
    assert.equal(cards.buildFollowupCard({ event: aborted, waiting: false }).header.template, 'grey');
});

test('续写回调映射：结束本轮 = 空裁决（不给 followup_message）', () => {
    assert.deepEqual(cards.followupResponses().stop_now.decision, {});
});

test('失败的工具并进摘要卡：❌ + 原因写在标题里，header 上有红标签', () => {
    const event = translateCursorHook(failureFixture);
    const failedStep = {
        tool: event.meta.toolName,
        icon: event.meta.icon,
        input: event.meta.inputSummary,
        result: event.meta.output,
        failed: true,
        failureReason: event.meta.failureReason,
    };
    const capture = { tools: true, output: true, results: true };

    const panel = cards.buildToolPanel(failedStep, capture);
    assert.match(panel.header.title.content, /❌ Shell — 执行超时/);
    assert.equal(panel.expanded, false, '失败也跟着折叠：显眼靠标题和卡头红标签，不靠撑长卡片');
    const panelBody = collect(panel.elements, 'markdown').map((e) => e.content).join('\n');
    assert.match(panelBody, /报错/);
    assert.match(panelBody, /Command timed out after 30s/);

    const card = cards.buildLiveCard({
        segments: [{ text: '', tools: [failedStep, { tool: 'Read', icon: '📖', input: 'src/a.js', result: 'ok' }] }],
        capture,
        model: 'claude-opus-5',
        projectName: 'agent_notifier',
    });
    const tags = card.header.text_tag_list.map((t) => t.text.content);
    assert.deepEqual(tags, ['2 步', '1 步失败']);
});

test('全成功的摘要卡不挂失败标签', () => {
    const card = cards.buildLiveCard({
        segments: [{ text: '', tools: [{ tool: 'Read', icon: '📖', input: 'src/a.js', result: 'ok' }] }],
        capture: { tools: true, output: true, results: true },
        model: '',
        projectName: '',
    });
    assert.deepEqual(card.header.text_tag_list.map((t) => t.text.content), ['1 步']);
});

test('完成卡收敛后保留助手正文，且不因为回话就刷成灰卡', () => {
    const event = translateCursorHook(stopFixture);
    const body = '把 redirect 默认值改成当前 origin，并补了一条回归测试。';

    for (const statusText of [
        '▶️ **已续写** — 顺手把 README 也更新一下',
        '⏹ 已结束本轮',
        '⏳ **已超时** — 未收到回复，本轮就地结束',
    ]) {
        const card = cards.buildSettledFollowupCard({ event, body, statusText });
        const json = JSON.stringify(card);

        assert.equal(card.header.template, 'green',
            `任务本身成功了，配色就该一直是绿的（当前状态文案：${statusText}）`);
        assert.ok(json.includes('redirect'), '助手正文必须保留下来');
        assert.ok(json.includes(statusText.replace(/\*\*/g, '')) || json.includes(statusText),
            '顶部要有回执文案');
        assert.equal(collect(card.body.elements, 'input').length, 0, '交互组件要撤掉');
        assert.equal(collect(card.body.elements, 'button').length, 0, '交互组件要撤掉');
        assert.match(footerText(card), /🤖 Cursor/);
    }
});

test('任务本身失败时收敛卡仍是红的（配色跟着任务成败，不跟着回话动作）', () => {
    const event = translateCursorHook({ ...stopFixture, status: 'error' });
    const card = cards.buildSettledFollowupCard({
        event, body: '构建失败', statusText: '⏹ 已结束本轮',
    });
    assert.equal(card.header.template, 'red');
    assert.match(JSON.stringify(card), /构建失败/);
});

test('收敛卡没有正文时也不崩，只显示回执', () => {
    const event = translateCursorHook(stopFixture);
    const card = cards.buildSettledFollowupCard({ event, body: '', statusText: '⏹ 已结束本轮' });
    assert.match(JSON.stringify(card), /已结束本轮/);
});

test('收敛卡：交互组件全撤、结果写在正文（交互卡靠超时/提交收敛）', () => {
    const event = translateCursorHook(shellFixture);
    const card = cards.buildSettledCard({
        event, statusText: '⏳ **已超时**', template: 'grey',
    });

    assert.equal(collect(card.body.elements, 'button').length, 0);
    assert.equal(collect(card.body.elements, 'input').length, 0);
    assert.match(card.header.title.content, /已处理/);
    assert.match(collect(card.body.elements, 'markdown')[0].content, /已超时/);
});

test('实时摘要卡：正文默认展开、工具默认折叠、标题只有一行预览、刻意无输入框', () => {
    const segments = [{
        text: '先跑一遍测试',
        tools: [
            { tool: 'Shell', icon: '⚡', input: 'npm test\n--watch=false', result: '42 passed' },
            { tool: 'Write', icon: '📝', input: 'src/a.ts', result: '' },
        ],
    }];
    const card = cards.buildLiveCard({
        segments,
        capture: { tools: true, output: true, results: true },
        model: 'claude-opus-5',
        projectName: 'agent_notifier',
    });

    const panels = collect(card.body.elements, 'collapsible_panel');
    // 1 个文字段面板 + 2 个工具面板
    assert.equal(panels.length, 3);

    // 正文默认展开、工具默认折叠：一张摘要卡里最该被读到的是 agent 说的话，不是过程
    assert.equal(panels[0].header.title.content, '❯ Cursor');
    assert.equal(panels[0].expanded, true);

    const toolPanel = panels[1];
    assert.equal(toolPanel.expanded, false);
    assert.equal(toolPanel.header.title.content.includes('\n'), false, '标题必须是单行');
    assert.match(toolPanel.header.title.content, /⚡ Shell {2}npm test/);

    assert.deepEqual(card.header.text_tag_list.map((t) => t.text.content), ['2 步']);
    assert.equal(collect(card.body.elements, 'input').length, 0,
        'Cursor 运行中没有可回流的输入通道，摆输入框会骗人');
    assert.match(footerText(card), /🤖 Cursor/);
});

test('会话名作副标题（Claude 卡同款形态）：一眼看出这张卡是哪个对话发的', () => {
    const named = (fixture) => {
        const event = translateCursorHook(fixture);
        event.meta.conversationName = '移除 cursor 工具失败的卡片';
        return event;
    };

    const stop = named(stopFixture);
    const approval = named(shellFixture);

    for (const card of [
        cards.buildFollowupCard({ event: stop, stateKey: 'k', body: '已完成', timeoutMs: 0, waiting: true }),
        cards.buildSettledFollowupCard({ event: stop, body: '已完成', statusText: '⏹ 已结束本轮' }),
        cards.buildApprovalCard({ event: approval, stateKey: 'k', timeoutMs: 1000 }),
        cards.buildSettledCard({ event: approval, statusText: '✅ 已允许' }),
        cards.buildLiveCard({
            segments: [{ text: '在改', tools: [] }],
            capture: { tools: true, output: true, results: true },
            model: '', projectName: '', conversationName: '移除 cursor 工具失败的卡片',
        }),
        cards.buildStallCard({ body: '', idleMs: 900000, projectName: '', model: '', conversationName: '移除 cursor 工具失败的卡片' }),
    ]) {
        assert.equal(card.header.subtitle.content, '移除 cursor 工具失败的卡片',
            `卡片 ${card.header.title.content} 少了副标题`);
    }

    // 取不到名字就别渲染一个空副标题出来
    const anon = cards.buildFollowupCard({ event: translateCursorHook(stopFixture), waiting: false });
    assert.equal(anon.header.subtitle, undefined);
});

test('正文再长也默认展开：长回答恰恰是最需要直接看到的那种', () => {
    const long = '这是一段很长的结论。'.repeat(80);
    for (const card of [
        cards.buildLiveCard({
            segments: [{ text: long, tools: [] }],
            capture: { tools: true, output: true, results: true },
            model: '', projectName: '',
        }),
        cards.buildCliTurnCard({
            segments: [{ text: long, tools: [] }],
            status: 'running', stateKey: 'k', projectName: '', model: '',
        }),
    ]) {
        const panel = collect(card.body.elements, 'collapsible_panel')[0];
        assert.equal(panel.header.title.content, '❯ Cursor');
        assert.equal(panel.expanded, true);
    }
});

test('实时摘要卡尊重 capture 开关：只要 tools 时不渲染结果与正文', () => {
    const segments = [{ text: '正文', tools: [{ tool: 'Shell', icon: '⚡', input: 'ls', result: 'a\nb' }] }];
    const card = cards.buildLiveCard({
        segments, capture: { tools: true, output: false, results: false }, model: '', projectName: '',
    });

    const body = JSON.stringify(card.body.elements);
    assert.match(body, /ls/);
    assert.doesNotMatch(body, /正文/);
    assert.doesNotMatch(body, /\*\*结果\*\*/);
});

test('长文本按块切分，避免被飞书截断', () => {
    const chunks = cards.splitText('x'.repeat(4000), 1800);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 1800);
    assert.deepEqual(cards.splitText(''), []);
});

test('卡死告警卡：说清为什么飞书帮不上，且绝不放交互组件', () => {
    const card = cards.buildStallCard({
        body: '我需要你在两个方案里选一个',
        idleMs: 180000,
        projectName: 'demo',
        model: 'claude-opus-5',
    });

    // 这张卡是在「没有任何 hook 在等待」时发出的，放输入框等于骗人
    assert.equal(collect(card.body.elements, 'input').length, 0);
    assert.equal(collect(card.body.elements, 'button').length, 0);

    const body = JSON.stringify(card.body.elements);
    assert.match(body, /已静止 3 分钟/);
    assert.match(body, /回到 IDE/, '必须告诉用户去哪里处理');
    assert.match(body, /我需要你在两个方案里选一个/, '要带上它最后说的话');
    assert.equal(card.header.template, 'yellow');
    assert.match(footerText(card), /🤖 Cursor/);
});

test('卡死告警卡：没有正文也能发，不会崩', () => {
    const card = cards.buildStallCard({ body: '', idleMs: 600000, projectName: '', model: '' });
    assert.match(JSON.stringify(card.body.elements), /已静止 10 分钟/);
});

test('落款带机器标识：远程机的卡片必须能看出是哪台', () => {
    const event = translateCursorHook(stopFixture);
    const prev = process.env.AGENT_NOTIFIER_MACHINE;

    try {
        process.env.AGENT_NOTIFIER_MACHINE = 'GY_2';
        const remote = cards.buildFollowupCard({ event, stateKey: null, body: 'x', timeoutMs: 0, waiting: false });
        assert.match(footerText(remote), /📍 GY_2/);

        delete process.env.AGENT_NOTIFIER_MACHINE;
        const local = cards.buildFollowupCard({ event, stateKey: null, body: 'x', timeoutMs: 0, waiting: false });
        assert.doesNotMatch(footerText(local), /📍/, '没配就不该出现，本机卡片保持原样');
    } finally {
        if (prev === undefined) delete process.env.AGENT_NOTIFIER_MACHINE;
        else process.env.AGENT_NOTIFIER_MACHINE = prev;
    }
});

// ── 提问卡（MCP ask_user）────────────────────────────────────────────────────

test('提问卡：选项渲染成按钮，且带输入框与取消按钮', () => {
    const card = cards.buildAskCard({
        question: '两个方案怎么选？',
        options: ['方案 A', '方案 B'],
        context: '背景：磁盘快满了',
        stateKey: 'k-ask',
        timeoutMs: 3000000,
        projectName: 'demo',
    });

    const buttons = collect(card.body.elements, 'button');
    assert.deepEqual(buttons.map((b) => b.value.action_type), ['opt_0', 'opt_1', 'interrupt']);
    assert.ok(buttons.every((b) => b.value.session_state_key === 'k-ask'));
    assert.equal(buttons[0].type, 'primary', '第一个选项高亮，方便一键选默认');

    const inputs = collect(card.body.elements, 'input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].value.action_type, 'text_input');

    const body = JSON.stringify(card.body.elements);
    assert.match(body, /两个方案怎么选/);
    assert.match(body, /磁盘快满了/);
    assert.match(body, /50 分钟|3000s/, '要把等待时长写在卡上');
    assert.match(footerText(card), /🤖 Cursor/);
});

test('提问卡：没有候选项时也能用（纯问答，只留输入框）', () => {
    const card = cards.buildAskCard({ question: '给个目录名', stateKey: 'k2', timeoutMs: 60000 });
    const buttons = collect(card.body.elements, 'button');
    assert.deepEqual(buttons.map((b) => b.value.action_type), ['interrupt']);
    assert.equal(collect(card.body.elements, 'input').length, 1);
});

test('提问卡回调映射：opt_N 带出选项原文，中断映射成取消', () => {
    const responses = cards.askResponses(['方案 A', '方案 B']);
    assert.deepEqual(responses.opt_0.decision, { answer: '方案 A' });
    assert.deepEqual(responses.opt_1.decision, { answer: '方案 B' });
    assert.deepEqual(responses.interrupt.decision, { cancelled: true });
    assert.equal(responses.opt_other, undefined, 'Other 只是展开输入框，不该有裁决');
});

test('提问卡收敛：保留问题正文，按有没有拿到答案区分配色', () => {
    const answered = cards.buildSettledAskCard({
        question: '两个方案怎么选？', answered: true, statusText: '✅ 用户选择了第 1 个选项：方案 A',
    });
    assert.equal(answered.header.template, 'green');
    assert.equal(collect(answered.body.elements, 'button').length, 0, '收敛必须撤掉交互组件');
    assert.equal(collect(answered.body.elements, 'input').length, 0);
    assert.match(JSON.stringify(answered.body.elements), /两个方案怎么选/, '正文是这张卡事后唯一的查阅价值');

    const timedOut = cards.buildSettledAskCard({
        question: 'Q', answered: false, statusText: '⏳ 已超时',
    });
    assert.equal(timedOut.header.template, 'grey');
});
