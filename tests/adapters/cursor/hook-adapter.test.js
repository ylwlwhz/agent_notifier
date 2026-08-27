'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const shellFixture = require('../../fixtures/cursor/before-shell-execution.json');
const mcpFixture = require('../../fixtures/cursor/before-mcp-execution.json');
const stopFixture = require('../../fixtures/cursor/stop.json');
const liveFixture = require('../../fixtures/cursor/post-tool-use.json');
const failureFixture = require('../../fixtures/cursor/post-tool-use-failure.json');
const responseFixture = require('../../fixtures/cursor/after-agent-response.json');

const {
    translateCursorHook,
    extractToolOutput,
    summarizeToolInput,
} = require('../../../src/adapters/cursor/hook-adapter');

test('beforeShellExecution 翻译成审批事件，正文含完整命令', () => {
    const event = translateCursorHook(shellFixture);

    assert.equal(event.host, 'cursor');
    assert.equal(event.kind, 'approval');
    assert.equal(event.eventType, 'approval_request');
    assert.equal(event.sessionId, 'cursor_conv-9f8e7d6c5b4a');
    assert.equal(event.sessionKey, 'conv-9f8');
    assert.equal(event.meta.subject, 'shell');
    assert.equal(event.meta.command, 'rm -rf build && npm run deploy');
    assert.equal(event.meta.projectName, 'agent_notifier');
    assert.equal(event.meta.model, 'claude-opus-5');
    assert.equal(event.meta.generationId, 'gen-0001');
    assert.match(event.message, /rm -rf build && npm run deploy/);
});

test('beforeMCPExecution 带出服务名并把 JSON 字符串参数美化', () => {
    const event = translateCursorHook(mcpFixture);

    assert.equal(event.kind, 'approval');
    assert.equal(event.meta.subject, 'mcp');
    assert.equal(event.meta.mcpServer, 'linear');
    assert.equal(event.title, 'MCP 调用确认');
    assert.match(event.message, /linear/);
    assert.match(event.message, /修复登录跳转/);
    assert.match(event.message, /```json/);
});

test('stop 翻译成续写事件，携带 status 与 loop_count', () => {
    const event = translateCursorHook(stopFixture);

    assert.equal(event.kind, 'followup');
    assert.equal(event.meta.status, 'completed');
    assert.equal(event.meta.loopCount, 0);
    assert.equal(event.meta.isSubagent, false);
});

test('subagentStop 走同一条续写链路但标记为子代理', () => {
    const event = translateCursorHook({
        hook_event_name: 'subagentStop',
        conversation_id: 'conv-1',
        subagent_type: 'explore',
        status: 'completed',
        summary: '已定位到鉴权入口',
        duration_ms: 45000,
        modified_files: ['src/auth.ts'],
    });

    assert.equal(event.kind, 'followup');
    assert.equal(event.meta.isSubagent, true);
    assert.equal(event.meta.subagentType, 'explore');
    assert.equal(event.meta.durationMs, 45000);
    assert.equal(event.message, '已定位到鉴权入口');
});

test('postToolUse 翻译成实时摘要事件，tool_output 剥掉 JSON 外壳', () => {
    const event = translateCursorHook(liveFixture);

    assert.equal(event.kind, 'live');
    assert.equal(event.eventType, 'live_status');
    assert.equal(event.meta.toolName, 'Shell');
    assert.equal(event.meta.icon, '⚡');
    assert.equal(event.meta.inputSummary, 'npm test');
    assert.equal(event.meta.output, '42 tests passed');
    assert.equal(event.meta.durationMs, 5432);
});

test('postToolUseFailure 翻译成失败事件并区分中断', () => {
    const event = translateCursorHook(failureFixture);

    assert.equal(event.kind, 'failure');
    assert.equal(event.meta.failureType, 'timeout');
    assert.equal(event.meta.isInterrupt, false);
    assert.match(event.message, /执行超时/);
    assert.match(event.message, /Command timed out after 30s/);

    const interrupted = translateCursorHook({ ...failureFixture, is_interrupt: true });
    assert.equal(interrupted.meta.isInterrupt, true);
});

test('afterAgentResponse 翻译成助手正文事件', () => {
    const event = translateCursorHook(responseFixture);

    assert.equal(event.kind, 'response');
    assert.equal(event.eventType, 'message');
    assert.match(event.message, /已修好登录跳转/);
});

test('未支持的事件归为 ignore，不会误触发任何链路', () => {
    for (const name of ['preCompact', 'workspaceOpen', 'afterFileEdit', 'sessionEnd']) {
        assert.equal(translateCursorHook({ hook_event_name: name }).kind, 'ignore', name);
    }
});

test('sessionStart 归为 session，并带上会话自身属性', () => {
    const event = translateCursorHook({
        hook_event_name: 'sessionStart',
        session_id: 'abcdef12-3456-7890-abcd-ef1234567890',
        is_background_agent: false,
        composer_mode: 'agent',
        workspace_roots: ['/Users/me/proj'],
    });

    assert.equal(event.kind, 'session');
    // 官方明说 sessionStart 的 session_id 就是 conversation_id，会话键必须照常算出来
    assert.equal(event.sessionKey, 'abcdef12');
    assert.equal(event.meta.isBackgroundAgent, false);
    assert.equal(event.meta.composerMode, 'agent');
    assert.equal(event.meta.projectName, 'proj');
});

test('缺少 conversation_id 时会话键退化为 unknown 而不是崩溃', () => {
    const event = translateCursorHook({ hook_event_name: 'stop', status: 'error' });
    assert.equal(event.sessionKey, 'unknown');
    assert.equal(event.sessionId, 'cursor_unknown');
});

test('extractToolOutput 兼容纯文本、stdout/stderr 与非 JSON', () => {
    assert.equal(extractToolOutput('plain text'), 'plain text');
    assert.equal(extractToolOutput('{"stdout":"ok","stderr":"warn"}'), 'ok\nwarn');
    assert.equal(extractToolOutput('{"not":"known"}'), '{\n  "not": "known"\n}');
    assert.equal(extractToolOutput(null), '');
});

test('summarizeToolInput 对不同工具取最有信息量的那个字段', () => {
    assert.equal(summarizeToolInput('Shell', { command: 'ls -al' }), 'ls -al');
    assert.equal(summarizeToolInput('Write', { path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(summarizeToolInput('StrReplace', { file_path: '/a/c.ts' }), '/a/c.ts');
    assert.equal(summarizeToolInput('Grep', { pattern: 'TODO' }), 'TODO');
});
