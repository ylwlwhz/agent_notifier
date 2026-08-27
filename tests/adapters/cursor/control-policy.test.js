'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseCursorControlConfig,
    shouldAskApproval,
    shouldWaitFollowup,
    timeoutDecision,
    renderHookOutput,
    QUESTION_STEER_CONTEXT,
} = require('../../../src/adapters/cursor/control-policy');

const shellEvent = (command) => ({
    kind: 'approval',
    meta: { eventName: 'beforeShellExecution', subject: 'shell', command },
});
const mcpEvent = (server, tool) => ({
    kind: 'approval',
    meta: { eventName: 'beforeMCPExecution', subject: 'mcp', mcpServer: server, toolName: tool },
});
const toolEvent = (toolName) => ({
    kind: 'approval',
    meta: { eventName: 'preToolUse', subject: 'tool', toolName },
});
const stopEvent = (status = 'completed', isSubagent = false) => ({
    kind: 'followup',
    meta: { eventName: isSubagent ? 'subagentStop' : 'stop', status, isSubagent },
});

test('默认配置：通知开、控制关（阻塞类必须显式打开）', () => {
    const config = parseCursorControlConfig({});

    assert.equal(config.enabled, true);
    assert.equal(config.notifyStop, true);
    assert.equal(config.notifyFailure, true);
    assert.equal(config.approval.enabled, false);
    assert.equal(config.followup.enabled, false);
    assert.equal(config.approval.timeoutMs, 180000);
    assert.equal(config.followup.timeoutMs, 300000);
});

test('提问形态引导默认开启：不开的话选择题永远无法远程作答', () => {
    assert.equal(parseCursorControlConfig({}).steerQuestions, true);
    assert.equal(parseCursorControlConfig({ CURSOR_STEER_QUESTIONS: '0' }).steerQuestions, false);
});

test('引导文案必须点名 AskQuestion，并给出「正文列选项 + 结束本轮」的替代做法', () => {
    assert.match(QUESTION_STEER_CONTEXT, /AskQuestion/);
    assert.match(QUESTION_STEER_CONTEXT, /结束本轮/);
});

test('卡死告警默认开启，阈值默认 15 分钟（3 分钟会在正常长回合里误报）', () => {
    // agent 组织长回复 / 做大上下文思考时什么事件都不产生，短阈值必然误报 —— 实测踩过
    assert.deepEqual(parseCursorControlConfig({}).stall, { enabled: true, idleMs: 900000 });
    assert.equal(parseCursorControlConfig({ CURSOR_STALL_ALERT_SEC: '600' }).stall.idleMs, 600000);
    assert.equal(parseCursorControlConfig({ CURSOR_STALL_ALERT: 'off' }).stall.enabled, false);
});

test('sessionStart 只放行 additional_context / env，别的字段一律丢掉', () => {
    const out = renderHookOutput('sessionStart', {
        additional_context: 'ctx',
        env: { A: '1' },
        permission: 'allow',       // 该事件不支持，必须被丢掉
        followup_message: 'nope',  // 同上
    });
    assert.deepEqual(out, { additional_context: 'ctx', env: { A: '1' } });
});

test('审批关闭时任何命令都不去飞书', () => {
    const config = parseCursorControlConfig({});
    assert.equal(shouldAskApproval(config, shellEvent('rm -rf /')), false);
});

test('审批开启后默认拦所有命令，配了 matcher 就只拦匹配的', () => {
    const all = parseCursorControlConfig({ CURSOR_REMOTE_APPROVAL: '1' });
    assert.equal(shouldAskApproval(all, shellEvent('ls')), true);

    const filtered = parseCursorControlConfig({
        CURSOR_REMOTE_APPROVAL: '1',
        CURSOR_APPROVAL_MATCHER: 'rm\\s|git push|npm publish',
    });
    assert.equal(shouldAskApproval(filtered, shellEvent('rm -rf build')), true);
    assert.equal(shouldAskApproval(filtered, shellEvent('git push origin main')), true);
    assert.equal(shouldAskApproval(filtered, shellEvent('ls -al')), false);
});

test('matcher 写错不会变成静默全放行，退化为不过滤', () => {
    const config = parseCursorControlConfig({
        CURSOR_REMOTE_APPROVAL: '1',
        CURSOR_APPROVAL_MATCHER: '([unclosed',
    });
    assert.equal(config.approval.shellMatcher, null);
    assert.equal(shouldAskApproval(config, shellEvent('anything')), true);
});

test('MCP matcher 匹配 <server>.<tool>', () => {
    const config = parseCursorControlConfig({
        CURSOR_REMOTE_APPROVAL: '1',
        CURSOR_APPROVAL_MCP_MATCHER: '^linear\\.',
    });
    assert.equal(shouldAskApproval(config, mcpEvent('linear', 'create_issue')), true);
    assert.equal(shouldAskApproval(config, mcpEvent('sentry', 'list_issues')), false);
});

test('preToolUse 必须显式列出工具名才接管（否则每个工具调用都要人点）', () => {
    const bare = parseCursorControlConfig({ CURSOR_REMOTE_APPROVAL: '1' });
    assert.equal(shouldAskApproval(bare, toolEvent('Write')), false);

    const listed = parseCursorControlConfig({
        CURSOR_REMOTE_APPROVAL: '1',
        CURSOR_APPROVE_TOOLS: 'Write, Delete',
    });
    assert.equal(shouldAskApproval(listed, toolEvent('Write')), true);
    assert.equal(shouldAskApproval(listed, toolEvent('Delete')), true);
    assert.equal(shouldAskApproval(listed, toolEvent('Read')), false);
});

test('续写只在 completed 时等人，失败/中断就地收尾', () => {
    const config = parseCursorControlConfig({ CURSOR_REMOTE_FOLLOWUP: '1' });
    assert.equal(shouldWaitFollowup(config, stopEvent('completed')), true);
    assert.equal(shouldWaitFollowup(config, stopEvent('error')), false);
    assert.equal(shouldWaitFollowup(config, stopEvent('aborted')), false);
});

test('子代理续写单独开关，默认不等', () => {
    const off = parseCursorControlConfig({ CURSOR_REMOTE_FOLLOWUP: '1' });
    assert.equal(shouldWaitFollowup(off, stopEvent('completed', true)), false);

    const on = parseCursorControlConfig({
        CURSOR_REMOTE_FOLLOWUP: '1',
        CURSOR_REMOTE_FOLLOWUP_SUBAGENT: 'true',
    });
    assert.equal(shouldWaitFollowup(on, stopEvent('completed', true)), true);
});

test('超时回落：审批交回本地弹窗，preToolUse 的 ask 不生效故回空', () => {
    assert.deepEqual(timeoutDecision(shellEvent('ls')), {
        permission: 'ask',
        user_message: '飞书审批超时，请在此确认',
    });
    assert.deepEqual(timeoutDecision(toolEvent('Write')), {});
    assert.deepEqual(timeoutDecision(stopEvent()), {});
});

test('输出只保留该事件支持的字段（多余字段会被 Cursor 判为无效 JSON）', () => {
    assert.deepEqual(
        renderHookOutput('beforeShellExecution', {
            permission: 'deny',
            agent_message: '别跑',
            followup_message: '不该出现',
            updated_input: { command: 'ls' },
        }),
        { permission: 'deny', agent_message: '别跑' }
    );

    assert.deepEqual(
        renderHookOutput('stop', { followup_message: '继续跑测试', permission: 'allow' }),
        { followup_message: '继续跑测试' }
    );

    // 空值不该出现在输出里：followup_message 为空串等于「不续写」
    assert.deepEqual(renderHookOutput('stop', { followup_message: '' }), {});
    // 只读事件没有可用输出字段
    assert.deepEqual(renderHookOutput('postToolUse', { additional_context: 'x' }), {});
});

test('CURSOR_NOTIFY_ENABLED=0 时整体停用', () => {
    assert.equal(parseCursorControlConfig({ CURSOR_NOTIFY_ENABLED: '0' }).enabled, false);
    assert.equal(parseCursorControlConfig({ CURSOR_NOTIFY_ENABLED: 'false' }).enabled, false);
});
