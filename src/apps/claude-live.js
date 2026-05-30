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
 *     results — 工具执行结果（折叠面板内展开查看，过长截断）
 *   FEISHU_LIVE_DEBOUNCE_MS=3000   debounce 延迟（毫秒，默认 3000）
 *
 * 触发并展示的工具（关键节点；Read/Grep 等纯本地只读不触发，避免刷屏）:
 *   Bash / Write / Edit / NotebookEdit / WebSearch / WebFetch
 */

const fs = require('fs');
const path = require('path');
require('../lib/env-config'); // 加载 .env
const { card2, termLabel } = require('../lib/card');
const { resolvePtsDevice } = require('../lib/terminal-inject');
const { KEY_TOOLS } = require('../lib/key-tools');

const TOOL_ICONS = {
    'Bash': '⚡',
    'Write': '📝',
    'Edit': '✏️',
    'NotebookEdit': '📓',
    'WebSearch': '🔍',
    'WebFetch': '🌐',
};

// ─── 入口分发 ─────────────────────────────────────────────────────────────────

/** --flush 跑 flush 子进程，否则跑 PostToolUse 主流程。
 *  hook 经 live-handler.js（require 本模块）调用，故不靠 require.main 自动执行——由调用方显式 run()。 */
function run() {
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
}

if (require.main === module) run(); // 直接 node claude-live.js / flush 子进程；被 require 时由调用方触发

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
        case 'WebSearch':
            return (toolInput.query || '');
        case 'WebFetch':
            return (toolInput.url || '');
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

// ─── 执行摘要卡构建 ───────────────────────────────────────────────────────────

function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/** 从 transcript 重建当前 turn（到上一条 user prompt 为止）的「文字段 → 其后工具」结构。
 *  text 块起一个新段，其后的 KEY_TOOLS 工具归入该段；tool_result 按 tool_use_id 回填。返回 { turnTs, segments } */
function reconstructSegments(transcriptPath) {
    let raw;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return { turnTs: 0, segments: [] }; }
    const lines = raw.trim().split('\n');
    let start = 0, turnTs = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const d = JSON.parse(lines[i]);
            if (d.type === 'user' && typeof d.message?.content === 'string') { start = i + 1; turnTs = +new Date(d.timestamp || 0); break; }
        } catch {}
    }
    const segments = [];
    const resultMap = {};
    let cur = null;
    for (let i = start; i < lines.length; i++) {
        let d; try { d = JSON.parse(lines[i]); } catch { continue; }
        if (d.type === 'assistant') {
            for (const b of d.message?.content || []) {
                if (b.type === 'text' && b.text?.trim()) {
                    // 连续多段文字累积进同一段（不吞文字）；只有已挂过工具后再出现的文字才另起一段
                    if (cur && cur.tools.length) cur = null;
                    if (!cur) { cur = { text: '', tools: [] }; segments.push(cur); }
                    cur.text = cur.text ? `${cur.text}\n\n${b.text.trim()}` : b.text.trim();
                } else if (b.type === 'tool_use' && KEY_TOOLS.has(b.name)) {
                    if (!cur) { cur = { text: '', tools: [] }; segments.push(cur); }
                    cur.tools.push({ tool: b.name, icon: TOOL_ICONS[b.name] || '🔧', input: formatToolInput(b.name, b.input), id: b.id });
                }
            }
        } else if (d.type === 'user' && Array.isArray(d.message?.content)) {
            for (const b of d.message.content) {
                // 包成 { content } 让 formatToolResult 的 .content 分支同时吃 string 与 text-block 数组
                if (b.type === 'tool_result' && b.tool_use_id) resultMap[b.tool_use_id] = formatToolResult({ content: b.content });
            }
        }
    }
    for (const s of segments) for (const t of s.tools) t.result = resultMap[t.id] || null;
    return { turnTs, segments };
}

const MAX_CMD_LINES = 15, MAX_RES_LINES = 15;
/** 取前 n 行，超出补省略号、去尾部空白 */
function clipLines(text, n) {
    const lines = String(text).split('\n');
    const head = lines.slice(0, n).join('\n').trimEnd();
    return lines.length > n ? `${head}\n…` : head;
}
/** 截到 n 字符（面板标题用，单行） */
function clipChars(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/** markdown 代码块元素（面板内可正常渲染，表格单元不能） */
const codeBlock = (text, lang = '') => ({ tag: 'markdown', content: '```' + lang + '\n' + text + '\n```' });

/** 一个工具 → 一张折叠面板：折叠时一行（图标+工具+命令首行），展开看完整命令+输出代码块 */
function toolPanel(e, capture) {
    const first = capture.tools && e.input
        ? clipChars(e.input.split('\n')[0].replace(/^(写入|编辑) /, ''), 56).replace(/`/g, "'")
        : '';
    const title = `**${e.icon} ${e.tool}**${first ? `　\`${first}\`` : ''}`;

    const body = [];
    if (capture.tools && e.input && e.input.includes('\n')) { // 单行命令已在标题，多行才补完整代码块
        body.push(codeBlock(clipLines(e.input, MAX_CMD_LINES), e.tool === 'Bash' ? 'bash' : ''));
    }
    if (capture.results && e.result) body.push(codeBlock(clipLines(e.result.trim(), MAX_RES_LINES)));
    if (!body.length) body.push({ tag: 'markdown', content: "<font color='grey'>（无输出）</font>" });

    return {
        tag: 'collapsible_panel', expanded: false,
        header: { title: { tag: 'markdown', content: title }, icon_position: 'right', icon_expanded_angle: -180 },
        border: { color: 'grey', corner_radius: '6px' }, padding: '6px 10px',
        elements: body,
    };
}

/** 单个「文字段 + 其工具」渲染成一张执行摘要卡 */
function buildSegmentCard(seg, projectName, capture, ptsDevice) {
    const elements = [];
    if (capture.output && seg.text) {
        elements.push({ tag: 'collapsible_panel', expanded: seg.text.length < 200, header: { title: { tag: 'plain_text', content: `❯ ${termLabel(ptsDevice) || 'Claude'}` } }, elements: [{ tag: 'markdown', content: seg.text }] });
        elements.push({ tag: 'hr' });
    }
    for (const e of seg.tools) elements.push(toolPanel(e, capture));
    return card2({
        template: 'blue',
        title: '执行摘要',
        tags: [{ text: `${seg.tools.length} 步`, color: 'blue' }],
        elements,
    });
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

    // 仅作 debounce 触发 + 携带 transcript 路径；卡片内容 flush 时从 transcript 重建（避免 flush race）。
    // ptsDevice 须在此（PostToolUse，ppid 为 claude）解析，flush 子进程的 ppid 已非 claude
    const entry = { transcriptPath: data.transcript_path, projectName: getProjectName(data.cwd), ptsDevice: resolvePtsDevice(process.ppid), ts: Date.now() };

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

    // ── 加载 session state（按段索引追踪各卡 message_id）──────────────────────
    const { sessionState } = require('../lib/session-state');
    await sessionState.load();

    const stateKey = 'live_msg_' + sessionKey;
    const existing = sessionState.data[stateKey];

    // flush 时 transcript 已落盘，按文字边界拆成多张卡（每段文字 + 其后工具一张）
    const capture = parseCaptureConfig() || {};
    const transcriptPath = entries[entries.length - 1]?.transcriptPath;
    const projectName = entries[entries.length - 1]?.projectName || '';
    const ptsDevice = entries[entries.length - 1]?.ptsDevice || null;
    const { turnTs, segments } = reconstructSegments(transcriptPath);
    const withTools = segments.filter(s => s.tools.length > 0); // 纯文字尾段交给绿色 Stop 卡，不在此重复
    if (!withTools.length) return;

    // 跨 turn（turnTs 变）重置卡片索引；同 turn 内按段索引：内容变才 patch、新段 create（触发通知）
    const cards = existing && existing.turnTs === turnTs ? (existing.cards || []) : [];
    for (let i = 0; i < withTools.length; i++) {
        const card = buildSegmentCard(withTools[i], projectName, capture, ptsDevice);
        const sig = hashStr(JSON.stringify(card.body.elements));
        const slot = cards[i];
        if (slot?.message_id) {
            if (slot.sig === sig) continue; // 内容没变 → 免一次 patch
            try {
                await client.im.message.patch({ path: { message_id: slot.message_id }, data: { content: JSON.stringify(card) } });
                slot.sig = sig;
            } catch (err) { console.error('[live/flush] patch 失败:', err.message); }
        } else {
            try {
                const r = await client.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
                });
                if (r?.data?.message_id) cards[i] = { message_id: r.data.message_id, sig };
            } catch (err) { console.error('[live/flush] 发送失败:', err.message); }
        }
    }
    sessionState.data[stateKey] = { turnTs, cards, created_at: Date.now() };
    sessionState.save();
}

module.exports = { run, reconstructSegments, formatToolInput, parseCaptureConfig, clipLines, buildSegmentCard, KEY_TOOLS };
