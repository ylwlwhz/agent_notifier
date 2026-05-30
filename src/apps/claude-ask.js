'use strict';

/**
 * Claude Code PreToolUse hook handler for AskUserQuestion
 *
 * 通过 stdin 收到 AskUserQuestion，发一张飞书 form 卡让用户手机作答。
 * 单题/多题、单选/多选统一走 buildQuestionsForm；listener 收 form_value 后回放注入 TUI。
 */

const fs = require('fs');
const Lark = require('@larksuiteoapi/node-sdk');
require('../lib/env-config');
const { sessionState } = require('../lib/session-state');
const { resolvePtsDevice } = require('../lib/terminal-inject');
const { buildQuestionsForm, buildSingleSelectCard } = require('../lib/feishu-card-utils');

// ── Utility functions ─────────────────────────────────────

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => { try { done(JSON.parse(data)); } catch { done({}); } });
        setTimeout(() => done({}), 3000).unref();
    });
}

/**
 * Extract contextText from the last assistant message in the transcript.
 * Looks for text blocks preceding the AskUserQuestion tool_use block.
 */
function extractContextText(transcriptPath) {
    if (!transcriptPath) return '';
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let d;
            try { d = JSON.parse(lines[i]); } catch { continue; }
            if (d.type !== 'assistant') continue;
            const content = d.message?.content || [];
            let contextText = '';
            let hasAskUserQuestion = false;
            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    contextText += block.text + '\n';
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                    hasAskUserQuestion = true;
                }
            }
            if (hasAskUserQuestion) {
                return contextText.trim();
            }
            return '';
        }
    } catch {}
    return '';
}

// ── Feishu client ─────────────────────────────────────────

async function getFeishuAppClient() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return null;

    const client = new Lark.Client({ appId, appSecret });

    let chatId = process.env.FEISHU_CHAT_ID;
    if (!chatId) {
        try {
            const resp = await client.im.chat.list({ params: { page_size: 5 } });
            const chats = resp?.data?.items || [];
            if (chats.length === 0) return null;
            chatId = chats[0].chat_id;
        } catch { return null; }
    }

    return { client, chatId };
}

// ── Card senders ──────────────────────────────────────────

// 回放元数据：单/多选 + 选项数（回放算键序用）+ header/选项 label（提交回显卡用）；中断键所有卡通用
const replayMeta = q => ({ multiSelect: !!q.multiSelect, optionCount: q.options.length, header: q.header || q.question || '', options: q.options.map(o => o.label) });

/** 发卡 + 登记回放 state；meta 区分卡型（_single_select / _questions_form）*/
async function sendCard(app, card, stateKey, ptsDevice, sessionId, notificationType, meta) {
    sessionState.addNotification(stateKey, {
        session_id: sessionId, notification_type: notificationType, pts_device: ptsDevice, created_at: Date.now(),
        responses: { esc: { keys: '\x1b', label: 'Esc' }, interrupt: { keys: '\x1b', label: '⛔ 中断' } },
        ...meta,
    });
    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        });
    } catch (err) {
        console.error('[ask-handler] 发送卡片失败:', err.message);
    }
}

/** 单题单选 → 按钮卡（点一下即答）；回放共用 buildReplayPlan：listener 按 opt_i / 自定义输入调 replayQuestions */
function sendSingleSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType) {
    return sendCard(app, buildSingleSelectCard(q, stateKey, ptsDevice), stateKey, ptsDevice, sessionId, notificationType,
        { _single_select: true, _questions: [replayMeta(q)] });
}

/** 多题 / 单题多选 → 单 form 卡：一次收齐答案，listener 收 form_value 后回放注入 TUI */
function sendQuestionsForm(app, questions, stateKey, ptsDevice, sessionId, notificationType) {
    return sendCard(app, buildQuestionsForm(questions, stateKey, ptsDevice), stateKey, ptsDevice, sessionId, notificationType,
        { _questions_form: true, _questions: questions.map(replayMeta) });
}

// ── Main ─────────────────────────────────────────────────

async function main() {
    const data = await readStdin();

    // Guard: only handle PreToolUse / AskUserQuestion
    if (data.hook_event_name !== 'PreToolUse') return;
    if (data.tool_name !== 'AskUserQuestion') return;

    // Guard: need Feishu app credentials
    if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) return;

    const app = await getFeishuAppClient();
    if (!app) return;

    const questions = data.tool_input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return;

    const sessionId = data.session_id || '';
    const transcriptPath = data.transcript_path || '';

    const stateKey = `feishu_ask_${sessionId.substring(0, 8)}_${Date.now()}`;
    const ptsDevice = resolvePtsDevice(process.ppid);
    const notificationType = 'AskUserQuestion';

    // Extract context text from transcript (text blocks before the AskUserQuestion tool_use)
    const contextText = extractContextText(transcriptPath);

    // Attach contextText to question objects for use in card builders
    questions.forEach(q => { q._contextText = contextText; });

    // 单题单选 → 按钮卡（一点即答）；其余（多题 / 单题多选）→ form 卡。两者回放共用 buildReplayPlan
    if (questions.length === 1 && !questions[0].multiSelect) {
        await sendSingleSelectCard(app, questions[0], stateKey, ptsDevice, sessionId, notificationType);
    } else {
        await sendQuestionsForm(app, questions, stateKey, ptsDevice, sessionId, notificationType);
    }
}

if (require.main === module) {
    main().catch(err => { console.error('[ask-handler]', err.message); process.exit(0); });
}

module.exports = {
    getFeishuAppClient,
    sendSingleSelectCard,
    sendQuestionsForm,
    main,
};
