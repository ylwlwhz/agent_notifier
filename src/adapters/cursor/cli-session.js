'use strict';

/**
 * cursor-agent CLI 适配层 —— Cursor「随时回复」能力的底座。
 *
 * 为什么需要它：Cursor 的 hooks 只是旁路观察者，往 IDE 里已存在的会话注入用户消息的
 * 唯一入口是 stop 的 followup_message，且只在一轮结束的瞬间存在（详见 docs/ai_rules.md）。
 * 而 `agent -p --resume <id> "消息"` 可以在【任意时刻】把消息推进一个会话并保留完整上下文，
 * 所以只要会话由我们自己创建、id 由我们自己保管，就能做到和 Claude/Codex 一样的随时回话。
 *
 * 实测要点（2026-08-26，版本 2026.08.11-e8db854）：
 *   - `--resume` 传【未知 id 不会报错】，而是用该 id 静默新建会话。
 *     这既是坑（id 记错会静默分叉）也是关键特性：我们可以自己生成 UUID，从诞生起就拥有会话。
 *   - `--resume` 拿【IDE 创建的会话】id 读不到任何历史，两者是不同命名空间。
 *   - 未受信任的工作区会直接拒绝执行，脚本化必须带 `--trust`。
 *   - `agent ls` / `create-chat` 在非 TTY 下会挂住，不可脚本化（我们也不需要：id 自己管）。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_ICONS = {
    Shell: '⚡',
    Read: '📖',
    Write: '📝',
    StrReplace: '✏️',
    Edit: '✏️',
    Delete: '🗑',
    Grep: '🔍',
    Glob: '📂',
    Ls: '📂',
    Task: '🧑‍🚀',
    TodoWrite: '✅',
    ReadLints: '🩺',
    EditNotebook: '📓',
    WebSearch: '🌐',
    WebFetch: '🌐',
};

/** 结果/命令摘要的截断长度，与卡片分块阈值同量级 */
const SUMMARY_MAX = 1800;

/** 自己生成会话 id：未知 id 会被 CLI 静默新建，于是我们从第一轮就拥有这个会话 */
function newCliSessionId() {
    return crypto.randomUUID();
}

/**
 * 找 agent 可执行文件。官方安装脚本落在 ~/.local/bin，而 listener 常由 launchd/systemd
 * 拉起——那种环境的 PATH 往往不含 ~/.local/bin，所以不能只靠 PATH 查找。
 */
function resolveAgentBin(env = process.env) {
    const configured = String(env.CURSOR_AGENT_BIN || '').trim();
    if (configured) return configured;

    const candidates = [
        path.join(os.homedir(), '.local', 'bin', 'agent'),
        path.join(os.homedir(), '.local', 'bin', 'cursor-agent'),
        '/usr/local/bin/agent',
        '/opt/homebrew/bin/agent',
    ];
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* 试下一个 */ }
    }
    return 'agent'; // 交给 PATH，找不到时 spawn 会报 ENOENT，由调用方如实上报
}

/**
 * 组装命令行参数。
 *
 * `--force` 的取舍：不加它，agent 遇到需要批准的命令会停在那里等人——而飞书发起的会话
 * 是无人值守的，等于挂死。加它就等于 yolo。仓库里 launcher.js 启动 Claude 时同样用的是
 * `--permission-mode bypassPermissions`，故此处默认放行，并允许用 CURSOR_CLI_FORCE=0 关掉。
 */
function buildAgentArgs({ sessionId, workspace, prompt, model, mode, force = true, outputFormat = 'stream-json' }) {
    if (!sessionId) throw new Error('buildAgentArgs requires sessionId');
    if (!workspace) throw new Error('buildAgentArgs requires workspace');

    const args = ['-p', '--trust', '--resume', sessionId, '--workspace', workspace, '--output-format', outputFormat];
    if (model) args.push('--model', model);
    if (mode) args.push('--mode', mode);
    if (force) args.push('--force');
    if (prompt != null && prompt !== '') args.push(String(prompt));
    return args;
}

/** `{ readToolCall: {...} }` → 工具名 'Read'；找不到就回 null */
function toolNameFromCall(toolCall) {
    if (!toolCall || typeof toolCall !== 'object') return null;
    const key = Object.keys(toolCall).find((k) => /ToolCall$/.test(k));
    if (!key) return null;
    const base = key.replace(/ToolCall$/, '');
    return base.charAt(0).toUpperCase() + base.slice(1);
}

function toolPayloadFromCall(toolCall) {
    if (!toolCall || typeof toolCall !== 'object') return null;
    const key = Object.keys(toolCall).find((k) => /ToolCall$/.test(k));
    return key ? toolCall[key] : null;
}

function truncate(text, max = SUMMARY_MAX) {
    const s = String(text == null ? '' : text);
    return s.length <= max ? s : s.slice(0, max) + '…（已截断）';
}

/** 工具入参 → 单行摘要。字段名与 hook payload 不完全一致，这里单独覆盖 CLI 的形状 */
function summarizeArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const direct = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url;
    if (direct != null) return truncate(String(direct), 400);
    if (args.prompt) return truncate(String(args.prompt), 200);
    if (args.edits || args.new_string) return truncate(String(args.path || args.file_path || ''), 400);
    return truncate(JSON.stringify(args), 300);
}

/** 工具结果 → 文本摘要。result 是 { success: {...} } 或 { error: ... } 的 oneof */
function summarizeToolResult(result) {
    if (!result || typeof result !== 'object') return { ok: true, text: '' };

    if (result.error !== undefined) {
        const err = result.error;
        const text = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
        return { ok: false, text: truncate(text) };
    }

    const payload = result.success !== undefined ? result.success : result;
    if (payload == null) return { ok: true, text: '' };
    if (typeof payload === 'string') return { ok: true, text: truncate(payload) };

    for (const field of ['content', 'stdout', 'output', 'text', 'result']) {
        if (typeof payload[field] === 'string') {
            const stderr = typeof payload.stderr === 'string' ? payload.stderr.trim() : '';
            const joined = stderr ? `${payload[field]}\n${stderr}`.trim() : payload[field];
            return { ok: true, text: truncate(joined) };
        }
    }
    return { ok: true, text: truncate(JSON.stringify(payload, null, 2)) };
}

/**
 * 一行 stream-json → 归一化事件；不认识的行返回 null（调用方直接忽略）。
 *
 * 真实事件种类（实测）：system/init、user、thinking/delta、thinking/completed、
 * assistant、tool_call/started、tool_call/completed、result/success。
 */
function parseStreamEvent(line) {
    const raw = String(line || '').trim();
    if (!raw) return null;

    let event;
    try { event = JSON.parse(raw); } catch { return null; }
    if (!event || typeof event !== 'object') return null;

    const kindKey = `${event.type}${event.subtype ? '/' + event.subtype : ''}`;

    if (kindKey === 'system/init') {
        return { kind: 'init', sessionId: event.session_id, model: event.model, cwd: event.cwd };
    }

    if (event.type === 'assistant') {
        const blocks = event.message?.content;
        const text = Array.isArray(blocks)
            ? blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n').trim()
            : '';
        return text ? { kind: 'text', text } : null;
    }

    if (event.type === 'tool_call') {
        const tool = toolNameFromCall(event.tool_call) || '工具';
        const payload = toolPayloadFromCall(event.tool_call) || {};
        const base = {
            callId: event.call_id || payload.toolCallId || null,
            tool,
            icon: TOOL_ICONS[tool] || '🔧',
            input: summarizeArgs(payload.args),
        };
        if (event.subtype === 'started') return { kind: 'tool_started', ...base };
        if (event.subtype === 'completed') {
            const { ok, text } = summarizeToolResult(payload.result);
            return { kind: 'tool_completed', ...base, ok, result: text };
        }
        return null;
    }

    if (event.type === 'result') {
        return {
            kind: 'result',
            isError: !!event.is_error || event.subtype === 'error',
            text: String(event.result || '').trim(),
            durationMs: Number(event.duration_ms || 0) || null,
            usage: event.usage || null,
            sessionId: event.session_id,
        };
    }

    return null; // user / thinking/* 目前不上卡片
}

/** 把 stdout 的字节流切成完整行；不完整的尾巴留在缓冲里等下一块 */
function createLineSplitter(onLine) {
    let buffer = '';
    return {
        push(chunk) {
            buffer += String(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) onLine(line);
        },
        flush() {
            if (buffer.trim()) onLine(buffer);
            buffer = '';
        },
    };
}

/**
 * 跑一轮对话。onEvent 收到的是 parseStreamEvent 的归一化事件。
 *
 * spawnFn 可注入，便于单测不真的起进程。
 * 环境变量里强制 CURSOR_NOTIFY_ENABLED=0：CLI 起的 agent 内部一样会跑本项目的 hooks，
 * 不关掉的话同一轮会既有 CLI 流式卡、又有 hook 通知卡，重复发两份。
 */
function runAgentTurn({
    sessionId,
    workspace,
    prompt,
    model = null,
    mode = null,
    force = true,
    env = process.env,
    agentBin = null,
    onEvent = () => {},
    spawnFn = null,
} = {}) {
    const bin = agentBin || resolveAgentBin(env);
    const args = buildAgentArgs({ sessionId, workspace, prompt, model, mode, force });
    const spawn = spawnFn || require('child_process').spawn;

    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(bin, args, {
                cwd: workspace,
                env: { ...env, CURSOR_NOTIFY_ENABLED: '0' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            return resolve({ ok: false, isError: true, text: `无法启动 ${bin}：${err.message}`, events: [] });
        }

        const events = [];
        let final = null;
        let stderr = '';

        const splitter = createLineSplitter((line) => {
            const event = parseStreamEvent(line);
            if (!event) return;
            events.push(event);
            if (event.kind === 'result') final = event;
            try { onEvent(event); } catch { /* 卡片渲染失败不该中断本轮 */ }
        });

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => splitter.push(chunk));
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        child.on('error', (err) => {
            resolve({ ok: false, isError: true, text: `启动 ${bin} 失败：${err.message}`, events });
        });

        child.on('close', (code) => {
            splitter.flush();
            if (final) {
                return resolve({
                    ok: !final.isError,
                    isError: final.isError,
                    text: final.text,
                    usage: final.usage,
                    durationMs: final.durationMs,
                    events,
                });
            }
            // 没拿到 result 事件：多半是 --trust 缺失、未登录、或 bin 不存在，
            // 把 stderr 原样带出去，否则用户只看到「没反应」
            resolve({
                ok: false,
                isError: true,
                text: (stderr.trim() || `agent 退出码 ${code}，且未产出 result 事件`).slice(0, 1000),
                events,
            });
        });
    });
}

module.exports = {
    newCliSessionId,
    resolveAgentBin,
    buildAgentArgs,
    parseStreamEvent,
    createLineSplitter,
    runAgentTurn,
    toolNameFromCall,
    summarizeArgs,
    summarizeToolResult,
    TOOL_ICONS,
};
