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
const { card2, termLabel } = require('../lib/card');
const { resolvePtsDevice } = require('../lib/terminal-inject');

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
                    cur = { text: b.text.trim(), tools: [] };
                    segments.push(cur);
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

/** 命令/文件的单行预览（标题用，防止多行在表格里相互重叠）：取首行并截断 */
function toolPreview(e) {
    const src = e.tool === 'Bash' ? (e.input || '') : (e.input || '').replace(/^(写入|编辑) /, '');
    const firstLine = src.split('\n')[0];
    return firstLine.length > 56 ? firstLine.slice(0, 56) + '…' : firstLine;
}

/** 单个工具 → 一张可折叠面板：标题=图标+工具+命令首行预览（单行），点击展开看完整命令 + 完整结果。
 *  改用折叠面板而非表格，彻底避开飞书表格多行单元格相互重叠的问题。 */
function buildToolPanel(e, capture) {
    const preview = capture.tools ? toolPreview(e) : '';
    const title = `${e.icon} ${e.tool}` + (preview ? `  ${preview}` : '');
    const body = [];
    if (capture.tools && e.input) {
        if (e.tool === 'Bash') {
            body.push({ tag: 'markdown', content: '```bash\n' + e.input + '\n```' });
        } else {
            body.push({ tag: 'markdown', content: '`' + e.input.replace(/^(写入|编辑) /, '') + '`' });
        }
    }
    if (capture.results && e.result) {
        body.push({ tag: 'markdown', content: '**结果**\n```\n' + e.result.trim() + '\n```' });
    }
    if (!body.length) body.push({ tag: 'markdown', content: '_（无更多详情）_' });
    return {
        tag: 'collapsible_panel',
        expanded: false, // 默认折叠 —— 点击后查看详细内容
        header: { title: { tag: 'plain_text', content: title } },
        elements: body,
    };
}

/** 把本轮「所有」文字段 + 其工具渲染成「一张」执行摘要卡（多段合并，不再每段一卡）。
 *  mergeInfo（可选）：合并进「已收到」卡时传入 { detail }，顶部保留回执、卡变绿、标题改「已收到 · 执行摘要」，
 *  避免 patch 直接把已收到卡内容覆盖没。 */
function buildSummaryCard(segments, projectName, capture, ptsDevice, mergeInfo = null) {
    const elements = [];
    if (mergeInfo) {
        if (mergeInfo.detail) elements.push({ tag: 'markdown', content: `✅ **已收到** · ${mergeInfo.detail}` });
        elements.push({ tag: 'hr' });
    }
    let totalSteps = 0;
    segments.forEach((seg, idx) => {
        if (idx > 0) elements.push({ tag: 'hr' }); // 段间分隔
        if (capture.output && seg.text) {
            elements.push({ tag: 'collapsible_panel', expanded: seg.text.length < 200, header: { title: { tag: 'plain_text', content: `❯ ${termLabel(ptsDevice) || 'Claude'}` } }, elements: [{ tag: 'markdown', content: seg.text }] });
        }
        seg.tools.forEach(e => { elements.push(buildToolPanel(e, capture)); totalSteps++; });
    });
    return card2({
        template: 'blue', // 与执行摘要同色；合并卡靠标题/顶部回执区分，不再用绿色
        title: mergeInfo ? '已收到 · 执行摘要' : '执行摘要',
        tags: [{ text: `${totalSteps} 步`, color: 'blue' }],
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

    // ── 读 session state 快照做决策（写回在结尾 mutateAsync 锁内 fresh load，只动本会话键）──
    const { sessionState } = require('../lib/session-state');
    sessionState.load();

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

    // 本轮若由飞书回复触发，listener 已写下「已收到」卡 message_id；新轮且够新 → 整张执行摘要卡 patch 进那张卡
    // （合并、保留回执），只用一次。无该键（终端直接发起）则照旧新发，零影响。
    const RECEIVED_TTL_MS = parseInt(process.env.FEISHU_RECEIVED_MERGE_TTL_MS || '600000', 10);
    const receivedKey = 'received_msg_' + sessionKey;
    const received = sessionState.data[receivedKey];
    const sameTurn = !!(existing && existing.turnTs === turnTs);

    // 合并回执：本轮卡已并过则沿用（existing.merge）；新轮且有够新 received 则并入「已收到」卡
    let mergeInfo = sameTurn ? (existing.merge || null) : null;
    let mergeIntoReceived = false;
    if (!sameTurn && !mergeInfo && received?.message_id && Date.now() - (received.created_at || 0) < RECEIVED_TTL_MS) {
        mergeInfo = { detail: received.detail || '' };
        mergeIntoReceived = true;
    }

    // 整轮所有段渲染成「一张」卡
    const card = buildSummaryCard(withTools, projectName, capture, ptsDevice, mergeInfo);
    const sig = hashStr(JSON.stringify(card.body.elements));
    const content = JSON.stringify(card);

    const sendCard = async (c) => {
        const r = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content: c },
        });
        return r?.data?.message_id || null;
    };

    let messageId = sameTurn ? existing.message_id : null;
    let storedSig = sameTurn ? existing.sig : null;

    if (messageId) {
        // 同轮：复用同一张卡，内容变才 patch（新段只追加进同卡，不再每段新发）
        if (storedSig !== sig) {
            try { await client.im.message.patch({ path: { message_id: messageId }, data: { content } }); storedSig = sig; }
            catch (err) { console.error('[live/flush] patch 失败:', err.message); }
        }
    } else if (mergeIntoReceived) {
        // 新轮：patch 进「已收到」卡（内容已含回执），失败则退回新发
        try { await client.im.message.patch({ path: { message_id: received.message_id }, data: { content } }); messageId = received.message_id; storedSig = sig; }
        catch (err) {
            console.error('[live/flush] 合并到「已收到」卡失败，改为新发:', err.message);
            try { messageId = await sendCard(content); storedSig = sig; } catch (err2) { console.error('[live/flush] 发送失败:', err2.message); }
        }
    } else {
        // 新轮、无「已收到」卡：照旧新发一张
        try { messageId = await sendCard(content); storedSig = sig; } catch (err) { console.error('[live/flush] 发送失败:', err.message); }
    }

    if (messageId) {
        // 锁内 fresh load 只写本会话两个键：flush 的网络窗口内常有 hook 并发 addNotification，
        // 旧快照整表 save 会把那些通知清掉 → 卡片一点就「已失效」。
        await sessionState.mutateAsync((data) => {
            if (mergeIntoReceived) delete data[receivedKey]; // 消费「已收到」卡，只并一次
            data[stateKey] = { turnTs, message_id: messageId, sig: storedSig, merge: mergeInfo, created_at: Date.now() };
        });
    }
}

// 仅供单测使用：导出纯函数，不影响上面的 main()/flushBuffer() 运行入口
module.exports = { buildSummaryCard, buildToolPanel, formatToolInput, formatToolResult, reconstructSegments };
