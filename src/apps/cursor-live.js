/**
 * Cursor 实时执行摘要 —— debounce 聚合版。
 *
 * 数据来源与 Claude 不同：Claude 要回读 transcript 重建这一轮，Cursor 的 postToolUse
 * payload 里已经带了 tool_input 与 tool_output，afterAgentResponse 带了助手正文，
 * 直接把它们攒进缓冲文件就够了，无需解析任何 transcript。
 *
 * 轮次边界用 generation_id —— 官方语义是「每条用户消息都会变」，正好等于「一轮」，
 * 不需要像 Codex 那样靠文本前缀去猜。同一轮 patch 同一张卡，新一轮才发新卡。
 *
 * 配置（.env）:
 *   FEISHU_LIVE_CAPTURE=1 | tools,output,results   与 Claude/Codex 同一套语义
 *   FEISHU_LIVE_DEBOUNCE_MS=3000
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 单轮在 state 里最多留这么多步：状态文件是多进程共享账本，不能让它无限长
const MAX_TURN_ENTRIES = 40;

/** 解析 FEISHU_LIVE_CAPTURE（与 claude-live / codex-live 同语义） */
function parseCaptureConfig() {
    const raw = (process.env.FEISHU_LIVE_CAPTURE || '').trim();
    if (!raw) return null;
    if (['true', '1', 'all', 'yes'].includes(raw.toLowerCase())) {
        return { tools: true, output: true, results: true };
    }
    const parts = raw.split(',').map((s) => s.trim().toLowerCase());
    return {
        tools: parts.includes('tools'),
        output: parts.includes('output'),
        results: parts.includes('results'),
    };
}

/** 缓冲文件名 → 会话键（cursor-live-<sessionKey>.jsonl） */
function sessionKeyFromBuffer(bufferPath) {
    return path.basename(bufferPath, '.jsonl').replace(/^cursor-live-/, '');
}

function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

/**
 * entries → 「助手文字段 + 其后的工具」结构。
 * 一段 text 起一个新段，后续 tool 归入该段；开头就是工具时补一个无文字的段。
 */
function buildSegments(entries) {
    const segments = [];
    let current = null;
    for (const entry of entries) {
        if (!entry) continue;
        if (entry.type === 'text') {
            current = { text: String(entry.text || '').trim(), tools: [] };
            segments.push(current);
            continue;
        }
        if (entry.type !== 'tool') continue;
        if (!current) { current = { text: '', tools: [] }; segments.push(current); }
        current.tools.push({
            tool: entry.tool || '工具',
            icon: entry.icon || '🔧',
            input: entry.input || '',
            result: entry.result || '',
        });
    }
    return segments;
}

/** 新轮（generation_id 变了）才发新卡；同轮 patch 旧卡 */
function shouldCreateNewCard(existing, generationId) {
    if (!existing || !existing.message_id) return true;
    return existing.generationId !== generationId;
}

/** 同轮则把历史步骤接上，避免 patch 后把前面的步骤覆盖没 */
function mergeTurnEntries(existing, fresh, generationId) {
    const prior = shouldCreateNewCard(existing, generationId) ? [] : (existing.entries || []);
    return prior.concat(fresh).slice(-MAX_TURN_ENTRIES);
}

// ── flush ────────────────────────────────────────────────────────────────────

async function flushBuffer(bufferPath) {
    if (!bufferPath) return;

    const capture = parseCaptureConfig();
    if (!capture) return;

    const debounceMs = parseInt(process.env.FEISHU_LIVE_DEBOUNCE_MS || '3000', 10);
    await new Promise((resolve) => setTimeout(resolve, debounceMs));

    // 缓冲还在被写 → 交给后来的 flush 进程，避免半轮就发卡
    let stat;
    try { stat = fs.statSync(bufferPath); } catch { return; }
    if (Date.now() - stat.mtimeMs < debounceMs - 500) return;

    let raw;
    try { raw = fs.readFileSync(bufferPath, 'utf8'); } catch { return; }

    const fresh = raw.trim().split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    if (!fresh.length) return;

    // 删缓冲 = 抢占：同一批 entries 只会被一个 flush 进程处理
    try { fs.unlinkSync(bufferPath); } catch { return; }

    require('../lib/env-config');
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return;

    // 走工厂而不是 new Lark.Client：出网强制走代理的机器上 SDK 传输层会静默挂住
    const { createLarkHttpClient } = require('../channels/feishu/feishu-client');
    const client = createLarkHttpClient({ appId, appSecret });
    const { resolveFeishuChatId } = require('../channels/feishu/resolve-chat-id');
    const chatId = await resolveFeishuChatId({
        preferredChatId: process.env.FEISHU_CHAT_ID,
        larkClient: client,
    });
    if (!chatId) return;

    const { sessionState } = require('../lib/session-state');
    const { buildLiveCard } = require('./cursor-cards');

    const sessionKey = sessionKeyFromBuffer(bufferPath);
    const stateKey = 'cursor_live_msg_' + sessionKey;

    // 只读快照做决策；写回放到结尾的 mutateAsync 锁内，只动自己这一个键。
    // 严禁「旧快照 → await 网络 → save 整表」：会把网络窗口期内别的进程刚写入的
    // 通知清掉，表现为飞书卡片随机变「已失效」（docs/ai_rules.md §7）。
    sessionState.load();
    const existing = sessionState.data[stateKey];

    const last = fresh[fresh.length - 1] || {};
    const generationId = last.generationId || '';
    const isNewCard = shouldCreateNewCard(existing, generationId);
    const entries = mergeTurnEntries(existing, fresh, generationId);

    const segments = buildSegments(entries);
    const hasContent = segments.some((s) => s.tools.length || (capture.output && s.text));
    if (!hasContent) return;

    const card = buildLiveCard({
        segments,
        capture,
        model: last.model || '',
        projectName: last.projectName || '',
    });
    const content = JSON.stringify(card);
    const sig = hashStr(JSON.stringify(card.body.elements));

    let messageId = isNewCard ? null : existing.message_id;
    if (messageId) {
        if (existing.sig !== sig) {
            try {
                await client.im.message.patch({ path: { message_id: messageId }, data: { content } });
            } catch (err) {
                console.error('[cursor-live] patch 失败:', err.message);
            }
        }
    } else {
        try {
            const resp = await client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: chatId, msg_type: 'interactive', content },
            });
            messageId = resp?.data?.message_id || null;
        } catch (err) {
            console.error('[cursor-live] 发送失败:', err.message);
        }
    }

    if (!messageId) return;
    await sessionState.mutateAsync((data) => {
        data[stateKey] = { generationId, message_id: messageId, sig, entries, created_at: Date.now() };
    });
}

if (require.main === module) {
    if (process.argv[2] === '--flush') {
        flushBuffer(process.argv[3]).catch((err) => {
            console.error('[cursor-live] flush 错误:', err.message);
            process.exit(0);
        });
    }
}

module.exports = {
    parseCaptureConfig,
    buildSegments,
    shouldCreateNewCard,
    mergeTurnEntries,
    sessionKeyFromBuffer,
    flushBuffer,
    MAX_TURN_ENTRIES,
};
