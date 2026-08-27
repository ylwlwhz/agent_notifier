'use strict';

/**
 * Cursor hook 事件 → 仓库内统一事件。
 *
 * Cursor 的 hook 协议（官方文档 https://cursor.com/docs/agent/hooks）与 Claude 的差别：
 *   1. 事件名是 camelCase（beforeShellExecution / postToolUse / stop …），不是 PascalCase
 *   2. 会话 id 字段是 conversation_id（generation_id 每轮变，不能当会话键）
 *   3. 部分事件是【阻塞】的：hook 在 stdout 上回 JSON 决定 Cursor 下一步做什么
 *      —— 这正是 Cursor 远程控制不需要 PTY 注入的原因
 *
 * kind 是本仓库自己的分类，决定 cursor-hook 走哪条链路：
 *   session   会话开始（sessionStart），注入 additional_context 引导提问形态
 *   approval  阻塞审批（beforeShellExecution / beforeMCPExecution / preToolUse）
 *   followup  阻塞续写（stop / subagentStop，回 followup_message 可让 Cursor 自动继续）
 *   response  助手正文（afterAgentResponse），供完成卡正文与实时摘要使用
 *   live      工具执行流水（postToolUse）
 *   failure   工具失败（postToolUseFailure）
 *   ignore    本仓库暂不处理
 */

const path = require('path');
const { EVENT_TYPES, HOSTS } = require('../../core/event-types');

const EVENT_KINDS = Object.freeze({
    sessionStart: 'session',
    beforeShellExecution: 'approval',
    beforeMCPExecution: 'approval',
    preToolUse: 'approval',
    stop: 'followup',
    subagentStop: 'followup',
    afterAgentResponse: 'response',
    postToolUse: 'live',
    postToolUseFailure: 'failure',
});

const EVENT_TYPE_BY_KIND = Object.freeze({
    session: EVENT_TYPES.MESSAGE,
    approval: EVENT_TYPES.APPROVAL_REQUEST,
    followup: EVENT_TYPES.TASK_RESULT,
    response: EVENT_TYPES.MESSAGE,
    live: EVENT_TYPES.LIVE_STATUS,
    failure: EVENT_TYPES.TASK_RESULT,
    ignore: EVENT_TYPES.MESSAGE,
});

const TOOL_ICONS = {
    Shell: '⚡',
    Write: '📝',
    StrReplace: '✏️',
    Edit: '✏️',
    Delete: '🗑',
    Read: '📖',
    Grep: '🔍',
    Glob: '📂',
    Task: '🧑‍🚀',
    EditNotebook: '📓',
};

const STOP_STATUS_TEXT = {
    completed: '任务已完成',
    aborted: '本轮已被中断',
    error: '本轮异常结束',
};

const FAILURE_TYPE_TEXT = {
    timeout: '执行超时',
    error: '执行出错',
    permission_denied: '权限被拒绝',
};

/** 工作区根目录：多根工作区取第一个；hook 环境变量 CURSOR_PROJECT_DIR 作兜底 */
function resolveWorkspaceRoot(payload = {}) {
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.filter(Boolean) : [];
    return roots[0] || payload.cwd || process.env.CURSOR_PROJECT_DIR || '';
}

function resolveProjectName(payload = {}) {
    const root = resolveWorkspaceRoot(payload);
    return root ? path.basename(root) : '';
}

/** 会话键：conversation_id 前 8 位。缓冲文件名、live 卡片状态键都用它 */
function resolveSessionKey(payload = {}) {
    const raw = String(payload.conversation_id || payload.session_id || '').trim();
    return raw ? raw.slice(0, 8) : 'unknown';
}

function truncate(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

/** MCP 的 tool_input 是 JSON 字符串，尽量美化；不是合法 JSON 就原样截断 */
function formatMcpInput(toolInput) {
    if (toolInput == null || toolInput === '') return '';
    if (typeof toolInput === 'object') return JSON.stringify(toolInput, null, 2);
    try { return JSON.stringify(JSON.parse(String(toolInput)), null, 2); }
    catch { return String(toolInput); }
}

/** 工具入参 → 单行摘要（卡片标题 / 折叠面板标题用） */
function summarizeToolInput(toolName, toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return '';
    if (toolName === 'Shell') return String(toolInput.command || '');
    const p = toolInput.path || toolInput.file_path || toolInput.target_notebook;
    if (p) return String(p);
    if (toolInput.pattern) return String(toolInput.pattern);
    if (toolInput.prompt) return truncate(String(toolInput.prompt), 120);
    return truncate(JSON.stringify(toolInput), 160);
}

/** postToolUse 的 tool_output 是「JSON 字符串化的结果」，不是终端原文，需要再剥一层 */
function extractToolOutput(toolOutput) {
    if (toolOutput == null) return '';
    if (typeof toolOutput === 'object') return JSON.stringify(toolOutput, null, 2);
    const raw = String(toolOutput);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw; }
    if (parsed == null) return '';
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed !== 'object') return String(parsed);
    const text = parsed.stdout ?? parsed.output ?? parsed.result ?? parsed.content ?? parsed.text;
    if (typeof text === 'string') {
        const stderr = typeof parsed.stderr === 'string' ? parsed.stderr.trim() : '';
        return stderr ? `${text}\n${stderr}`.trim() : text;
    }
    return JSON.stringify(parsed, null, 2);
}

/** 审批卡正文：把「即将发生什么」讲清楚，用户在飞书上只看这段就能决定放不放 */
function describeApproval(payload = {}) {
    const event = payload.hook_event_name;

    if (event === 'beforeShellExecution') {
        const cmd = String(payload.command || '').trim();
        const lines = [`⚡ **Shell**\n\`\`\`bash\n${truncate(cmd, 2000) || '(空命令)'}\n\`\`\``];
        if (payload.cwd) lines.push(`📂 \`${payload.cwd}\``);
        if (payload.sandbox) lines.push('🧪 沙箱模式执行');
        return lines.join('\n');
    }

    if (event === 'beforeMCPExecution') {
        const server = payload.mcp_server_name || '未知服务';
        const tool = payload.tool_name || '未知工具';
        const args = formatMcpInput(payload.tool_input);
        const lines = [`🔌 **MCP** \`${server}\` · \`${tool}\``];
        if (args) lines.push('```json\n' + truncate(args, 1500) + '\n```');
        const url = payload.mcp_server_url || payload.url;
        if (url) lines.push(`🌐 \`${url}\``);
        return lines.join('\n');
    }

    const tool = payload.tool_name || '未知工具';
    const icon = TOOL_ICONS[tool] || '🔧';
    const lines = [`${icon} **${tool}**`];
    const summary = summarizeToolInput(tool, payload.tool_input);
    if (summary) {
        lines.push(tool === 'Shell'
            ? '```bash\n' + truncate(summary, 2000) + '\n```'
            : `\`${truncate(summary, 300)}\``);
    }
    if (payload.agent_message) lines.push(`\n💬 ${truncate(payload.agent_message, 500)}`);
    return lines.join('\n');
}

function describeFailure(payload = {}) {
    const tool = payload.tool_name || '未知工具';
    const icon = TOOL_ICONS[tool] || '🔧';
    const reason = FAILURE_TYPE_TEXT[payload.failure_type] || '执行失败';
    const lines = [`${icon} **${tool}** — ${reason}`];
    const summary = summarizeToolInput(tool, payload.tool_input);
    if (summary) lines.push('```\n' + truncate(summary, 800) + '\n```');
    if (payload.error_message) lines.push('```\n' + truncate(payload.error_message, 1500) + '\n```');
    return lines.join('\n');
}

/**
 * 统一翻译入口。返回的对象既含仓库统一事件字段（host/sessionId/eventType），
 * 也含 cursor-hook 决策所需的 kind/meta。
 */
function translateCursorHook(payload = {}) {
    const eventName = payload.hook_event_name || '';
    const kind = EVENT_KINDS[eventName] || 'ignore';
    const sessionKey = resolveSessionKey(payload);
    const conversationId = payload.conversation_id || payload.session_id || '';

    const meta = {
        transport: 'hooks',
        eventName,
        conversationId,
        generationId: payload.generation_id || '',
        model: payload.model_id || payload.model || '',
        cursorVersion: payload.cursor_version || '',
        workspaceRoot: resolveWorkspaceRoot(payload),
        projectName: resolveProjectName(payload),
        cwd: payload.cwd || '',
        transcriptPath: payload.transcript_path || null,
    };

    let title = 'Cursor';
    let message = '';

    if (kind === 'session') {
        // sessionStart 的 session_id 就是 conversation_id（官方明说），所以上面的
        // resolveSessionKey 已经拿到了正确的会话键，这里只补会话自身的属性
        meta.isBackgroundAgent = !!payload.is_background_agent;
        meta.composerMode = payload.composer_mode || '';
        title = '会话开始';
    } else if (kind === 'approval') {
        meta.subject = eventName === 'beforeShellExecution' ? 'shell'
            : eventName === 'beforeMCPExecution' ? 'mcp' : 'tool';
        meta.toolName = payload.tool_name || (meta.subject === 'shell' ? 'Shell' : '');
        meta.command = payload.command || '';
        meta.mcpServer = payload.mcp_server_name || '';
        title = meta.subject === 'mcp' ? 'MCP 调用确认' : '权限确认';
        message = describeApproval(payload);
    } else if (kind === 'followup') {
        meta.status = payload.status || 'completed';
        meta.loopCount = Number(payload.loop_count || 0);
        meta.isSubagent = eventName === 'subagentStop';
        if (meta.isSubagent) {
            meta.subagentType = payload.subagent_type || '';
            meta.summary = payload.summary || '';
            meta.durationMs = Number(payload.duration_ms || 0) || null;
            meta.modifiedFiles = Array.isArray(payload.modified_files) ? payload.modified_files : [];
        }
        title = meta.isSubagent ? `子代理结束 · ${meta.subagentType || 'subagent'}` : 'Cursor 完成';
        message = meta.summary || STOP_STATUS_TEXT[meta.status] || String(meta.status);
    } else if (kind === 'response') {
        message = String(payload.text || '').trim();
        title = 'Cursor 回复';
    } else if (kind === 'live') {
        meta.toolName = payload.tool_name || '';
        meta.icon = TOOL_ICONS[meta.toolName] || '🔧';
        meta.toolInput = payload.tool_input || null;
        meta.inputSummary = summarizeToolInput(meta.toolName, payload.tool_input);
        meta.output = extractToolOutput(payload.tool_output);
        meta.durationMs = Number(payload.duration || 0) || null;
        title = '执行摘要';
        message = meta.inputSummary;
    } else if (kind === 'failure') {
        meta.toolName = payload.tool_name || '';
        meta.failureType = payload.failure_type || 'error';
        meta.isInterrupt = !!payload.is_interrupt;
        title = '工具执行失败';
        message = describeFailure(payload);
    }

    return {
        host: HOSTS.CURSOR,
        sessionId: conversationId ? `cursor_${conversationId}` : 'cursor_unknown',
        sessionKey,
        eventType: EVENT_TYPE_BY_KIND[kind],
        kind,
        title,
        message,
        meta,
        createdAt: Date.now(),
    };
}

module.exports = {
    translateCursorHook,
    describeApproval,
    describeFailure,
    extractToolOutput,
    summarizeToolInput,
    resolveProjectName,
    resolveWorkspaceRoot,
    resolveSessionKey,
    EVENT_KINDS,
    TOOL_ICONS,
};
