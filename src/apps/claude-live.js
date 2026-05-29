/**
 * Claude Code PostToolUse Hook — 实时执行通知（debounce 聚合版）
 * 在关键工具调用后，将 entry 写入缓冲文件，3 秒无新调用后统一发一张聚合卡片。
 *
 * 配置（.env）:
 *   FEISHU_LIVE_CAPTURE=1          开启，默认捕获全部三项
 *   FEISHU_LIVE_CAPTURE=true       同上
 *   FEISHU_LIVE_CAPTURE=tools,output,results  精细控制
 *     tools   — 工具名 + 关键参数（命令、文件路径）
 *     output  — Claude 上一段助手文字
 *     results — 工具执行结果（前 5 行）
 *   FEISHU_LIVE_DEBOUNCE_MS=3000   debounce 延迟（毫秒，默认 3000）
 *
 * 触发工具（关键节点，只读操作不触发）:
 *   Bash / Write / Edit / NotebookEdit
 */

const fs = require('fs');
const path = require('path');
require('../lib/env-config'); // 加载 .env
const { buildCardFooter } = require('../lib/card-footer');
const { extractLastAssistantText } = require('../lib/transcript-utils');

const KEY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);

const TOOL_ICONS = {
    'Bash': '⚡',
    'Write': '📝',
    'Edit': '✏️',
    'NotebookEdit': '📓',
};

// ─── Flush 模式：在文件最开始检测，不走 main() ───────────────────────────────

if (process.argv[2] === '--flush') {
    flushBuffer(process.argv[3]).catch(err => {
        console.error('[live/flush] 错误:', err.message);
        process.exit(0);
    });
} else {
    main().catch(err => {
        console.error('[live] 错误:', err.message);
        process.exit(0);
    });
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 解析 FEISHU_LIVE_CAPTURE 配置 */
function parseCaptureConfig() {
    const raw = (process.env.FEISHU_LIVE_CAPTURE || '').trim();
    if (!raw) return null;
    if (['true', '1', 'all', 'yes'].includes(raw.toLowerCase())) {
        return { tools: true, output: true, results: true };
    }
    const parts = raw.split(',').map(s => s.trim().toLowerCase());
    return {
        tools: parts.includes('tools'),
        output: parts.includes('output'),
        results: parts.includes('results'),
    };
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); } catch { done({}); }
        });
        setTimeout(() => done({}), 3000).unref();
    });
}

function getProjectName(cwd) {
    if (!cwd) return '';
    try {
        const pkgPath = path.join(cwd, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.name) return pkg.name;
        }
    } catch {}
    return path.basename(cwd);
}

function getTimestamp() {
    return new Date().toLocaleString('zh-CN', {
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

/** 格式化工具输入摘要 */
function formatToolInput(toolName, toolInput) {
    if (!toolInput) return '';
    switch (toolName) {
        case 'Bash':
            return (toolInput.command || '');
        case 'Write':
            return `写入 ${toolInput.file_path || ''}`;
        case 'Edit':
            return `编辑 ${toolInput.file_path || ''}`;
        case 'NotebookEdit':
            return `编辑 ${toolInput.notebook_path || ''}`;
        default:
            return JSON.stringify(toolInput);
    }
}

/** 格式化工具结果摘要（截断） */
function formatToolResult(toolResponse) {
    if (toolResponse == null) return null;
    let text = '';
    if (typeof toolResponse === 'string') {
        text = toolResponse;
    } else if (typeof toolResponse.output === 'string') {
        text = toolResponse.output;
    } else if (Array.isArray(toolResponse.content)) {
        text = toolResponse.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
    } else if (typeof toolResponse.content === 'string') {
        text = toolResponse.content;
    } else {
        text = JSON.stringify(toolResponse);
    }
    if (!text) return null;
    return text.trim().split('\n').join('\n');
}

// ─── 模式 1：正常模式（PostToolUse hook 调用）────────────────────────────────

async function main() {
    const capture = parseCaptureConfig();
    if (!capture) return;

    const data = await readStdin();
    if (data.hook_event_name !== 'PostToolUse') return;

    const toolName = data.tool_name;
    if (!KEY_TOOLS.has(toolName)) return;

    const sessionId = data.session_id || 'unknown';
    const bufferPath = `/tmp/claude-live-${sessionId.slice(0, 8)}.jsonl`;

    const entry = {
        tool: toolName,
        icon: TOOL_ICONS[toolName] || '🔧',
        input: capture.tools ? formatToolInput(toolName, data.tool_input) : null,
        result: capture.results ? formatToolResult(data.tool_response) : null,
        output: capture.output ? extractLastAssistantText(data.transcript_path) : null,
        ts: Date.now(),
        projectName: getProjectName(data.cwd),
        // 始终记录 assistant 文字指纹，用于 flush 判断是否换了新任务
        assistantKey: (() => {
            const t = extractLastAssistantText(data.transcript_path);
            return t ? t.trim().slice(0, 80) : '';
        })(),
    };

    // 追加 entry 到缓冲文件
    fs.appendFileSync(bufferPath, JSON.stringify(entry) + '\n', 'utf8');

    // spawn 延迟 flush 子进程（detached，主进程无需等待）
    const child = require('child_process').spawn('node', [
        __filename, '--flush', bufferPath
    ], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
}

// ─── 模式 2：flush 模式（--flush <bufferPath>）───────────────────────────────

async function flushBuffer(bufferPath) {
    if (!bufferPath) return;

    const debounceMs = parseInt(process.env.FEISHU_LIVE_DEBOUNCE_MS || '3000', 10);

    await new Promise((resolve) => setTimeout(resolve, debounceMs));

    // 检查缓冲文件 mtime：还在写入则退出，让后续 flush 进程处理
    let stat;
    try {
        stat = fs.statSync(bufferPath);
    } catch {
        return; // 文件不存在（已被其他 flush 进程处理）
    }
    if (Date.now() - stat.mtimeMs < debounceMs - 500) return;

    // 读取所有行
    let raw;
    try {
        raw = fs.readFileSync(bufferPath, 'utf8');
    } catch {
        return;
    }

    const entries = raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (!entries.length) return;

    // 删除缓冲文件（防重复发送，竞争安全）
    try {
        fs.unlinkSync(bufferPath);
    } catch {
        // 另一个 flush 进程已删除，退出
        return;
    }

    // 从 bufferPath 派生 sessionKey，用于在 session-state 中存储 message_id
    const sessionKey = path.basename(bufferPath, '.jsonl').replace('claude-live-', '');

    // 加载 env-config（dotenv）获取飞书凭证
    const { envConfig } = require('../lib/env-config');
    void envConfig;

    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return;

    const Lark = require('@larksuiteoapi/node-sdk');
    const client = new Lark.Client({ appId, appSecret });

    let chatId = process.env.FEISHU_CHAT_ID;
    if (!chatId) {
        try {
            const resp = await client.im.chat.list({ params: { page_size: 5 } });
            const chats = resp?.data?.items || [];
            if (!chats.length) return;
            chatId = chats[0].chat_id;
        } catch { return; }
    }

    // ── 加载 session state，合并已有 entries ──────────────────────────────────
    const { sessionState } = require('../lib/session-state');
    await sessionState.load();

    const stateKey = 'live_msg_' + sessionKey;
    const existing = sessionState.data[stateKey];

    // Claude 输出文字变了 → 新任务 → 重置 entries 并 create 新卡（触发通知）
    // 同一段 Claude 输出内的工具调用 → 静默 patch 同一张卡
    const currentKey = entries[0]?.assistantKey || '';
    const existingKey = existing?.assistantKey || '';
    const isNewTask = currentKey !== '' && existingKey !== '' && currentKey !== existingKey;

    // 合并已有 entries（新任务时重置），最多保留 40 条
    const allEntries = [...(isNewTask ? [] : (existing?.entries || [])), ...entries].slice(-40);

    // ── 构建聚合卡片 ──────────────────────────────────────────────────────────

    // 详情列不裁剪，飞书自行处理；只取 stdout 第一行避免 heredoc 噪声
    const TOOL_COLOR = { Bash: 'blue', Edit: 'green', Write: 'orange', Read: 'grey', NotebookEdit: 'purple' };

    const stepRows = allEntries.map((e) => {
        let cmd = '';
        if (e.input) {
            if (e.tool === 'Bash') {
                cmd = '`' + e.input.split('\n')[0] + '`';
            } else {
                cmd = e.input.replace(/^(写入|编辑) /, '');
            }
        }
        const res = e.result ? e.result.split('\n')[0].trim() : '';
        return {
            tool: [{ text: `${e.icon} ${e.tool}`, color: TOOL_COLOR[e.tool] || 'cyan' }],
            cmd: cmd || '—',
            res: res || '—',
        };
    });

    const tableEl = {
        tag: 'table',
        element_id: 'exec_steps',
        page_size: 10,              // 飞书上限 [1,10]
        row_height: 'low',          // 'auto' docs 写支持但 API 不实装
        row_max_height: '300px',
        header_style: { text_align: 'left', background_style: 'grey', bold: true },
        columns: [
            { name: 'tool', display_name: '工具',       data_type: 'options', width: '100px', vertical_align: 'top' },
            { name: 'cmd',  display_name: '命令 / 文件', data_type: 'lark_md', width: '60%',   vertical_align: 'top' },
            { name: 'res',  display_name: '结果',       data_type: 'text',    width: 'auto',  vertical_align: 'top' },
        ],
        rows: stepRows,
    };

    const lastWithOutput = [...allEntries].reverse().find(e => e.output);
    const claudeOutput = lastWithOutput?.output || null;

    const projectName = allEntries[0]?.projectName || '';
    const footerEl = buildCardFooter({ host: 'claude', projectName });

    const cardElements = [];
    if (claudeOutput) {
        cardElements.push({
            tag: 'collapsible_panel',
            expanded: claudeOutput.length < 200,
            header: { title: { tag: 'plain_text', content: '💬 Claude' } },
            elements: [{ tag: 'markdown', content: claudeOutput }],
        });
        cardElements.push({ tag: 'hr' });
    }
    cardElements.push(tableEl);
    cardElements.push(footerEl);

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `⚡ 执行摘要（${allEntries.length} 步）` },
            template: 'blue',
        },
        elements: cardElements,
    };

    // ── Patch-or-create：同一任务静默 patch，新任务 create 触发通知 ──────────────

    let patched = false;
    if (!isNewTask && existing?.message_id) {
        try {
            await client.im.message.patch({
                path: { message_id: existing.message_id },
                data: { content: JSON.stringify(card) },
            });
            patched = true;
            sessionState.data[stateKey] = { ...existing, entries: allEntries, assistantKey: currentKey || existingKey };
            sessionState.save();
        } catch (err) {
            console.error('[live/flush] patch 失败，改为 create:', err.message);
        }
    }

    if (!patched) {
        try {
            const result = await client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'interactive',
                    content: JSON.stringify(card),
                },
            });
            if (result?.data?.message_id) {
                sessionState.data[stateKey] = {
                    message_id: result.data.message_id,
                    entries: allEntries,
                    assistantKey: currentKey || existingKey,
                    created_at: Date.now(),
                };
                sessionState.save();
            }
        } catch (err) {
            console.error('[live/flush] 发送失败:', err.message);
        }
    }
}
