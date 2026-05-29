/**
 * Claude Code Hook 统一处理器
 * 读取 hook stdin JSON，根据事件类型发送不同格式的飞书卡片通知
 *
 * 支持的事件:
 *   Stop         - 任务完成，携带最后一条助手消息
 *   Notification - 等待用户操作（权限确认、方案选择等）
 *   StopFailure  - 异常退出（API 错误等）
 */

const fs = require('fs');
const path = require('path');
const { envConfig } = require('../lib/env-config');
const { sessionState } = require('../lib/session-state');
const { resolvePtsDevice } = require('../lib/terminal-inject');
const Lark = require('@larksuiteoapi/node-sdk');
const { parseMarkdownToElements } = require('../lib/feishu-card-utils');
const { card2, statsTags, inputEl, buttonRow, footer, escFooterRow } = require('../lib/card');
const { forEachTail, findTail, getAssistantText } = require('../lib/transcript-utils');
const { fmtDuration, readOfficialStats } = require('../lib/session-stats');

// ── 会话统计 ─────────────────────────────────────────────

function parseSessionStats(transcriptPath) {
    if (!transcriptPath) return null;
    try {
        const raw = fs.readFileSync(transcriptPath, 'utf8').trim();
        if (!raw) return null;

        const timestamps = [];
        for (const line of raw.split('\n')) {
            let d;
            try { d = JSON.parse(line); } catch { continue; }
            if (d.timestamp) timestamps.push(d.timestamp);
        }

        const duration = timestamps.length >= 2
            ? fmtDuration(new Date(timestamps[timestamps.length - 1]) - new Date(timestamps[0]))
            : '';

        return { duration };
    } catch {
        return null;
    }
}

// ── 工具函数 ─────────────────────────────────────────────

/** 从 transcript 提取最近的 AskUserQuestion 数据及上下文文本 */
function extractAskUserQuestion(transcriptPath) {
    if (!transcriptPath) return null;
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        // 只检查最后一条 assistant 消息，避免读到更早的 AskUserQuestion
        for (let i = lines.length - 1; i >= 0; i--) {
            let d;
            try { d = JSON.parse(lines[i]); } catch { continue; }
            if (d.type !== 'assistant') continue;
            // 找到最后一条 assistant 消息，检查是否包含 AskUserQuestion
            const content = d.message?.content || [];
            let askInput = null;
            let contextText = '';
            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    contextText += block.text + '\n';
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                    askInput = block.input;
                }
            }
            if (askInput) {
                askInput._contextText = contextText.trim();
                return askInput;
            }
            return null;
        }
    } catch {}
    return null;
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); }
            catch { done({}); }
        });
        // 兜底防 stdin 卡死；.unref() 让 timer 不阻塞进程退出
        setTimeout(() => done({}), 3000).unref();
    });
}

/** session 是否 bypass：先看 payload，否则 transcript 反扫 permissionMode */
function isBypassMode(data) {
    if (data.permission_mode === 'bypassPermissions') return true;
    return findTail(data.transcript_path, (d) =>
        d.permissionMode !== undefined ? d.permissionMode === 'bypassPermissions' : undefined
    ) === true;
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

// ── 卡片构建 ─────────────────────────────────────────────

/** Stop / StopFailure 卡：会话名作副标题，时长/成本等官方字段作 header 标签，正文为 body；输入框与 footer 由发送侧补 */
function buildCard(title, body, template, stats) {
    return card2({ template, title, subtitle: stats?.sessionName, tags: statsTags(stats), elements: parseMarkdownToElements(body) });
}

// ── 事件处理 ─────────────────────────────────────────────

const STOP_BODY_MAX = 6000; // 飞书卡片 content 上限约 30KB，body 留足余量兜底极端单轮

function handleStop(data, getStats) {
    // 只收「最近一次 tool_use 之后」的 text：之前的 narration 已由蓝色 live 卡显示，避免重复
    // （无工具的纯文本 turn 收到 user prompt 边界 = 全部）。last_assistant_message 补未 flush 的尾段
    const texts = [];
    let boundaryTs = 0; // 停下来的边界 ts（最近一次 tool_use，或无工具时的 user prompt），作去重 epoch
    forEachTail(data.transcript_path, (d) => {
        const ts = +new Date(d.timestamp || 0);
        if (d.type === 'user' && typeof d.message?.content === 'string') { boundaryTs = ts; return true; }
        if (d.type !== 'assistant') return false;
        if ((d.message?.content || []).some(b => b.type === 'tool_use')) { boundaryTs = ts; return true; }
        const text = getAssistantText(d);
        if (text) texts.unshift(text);
        return false;
    });
    const last = (data.last_assistant_message || '').trim();
    if (last && texts[texts.length - 1] !== last) texts.push(last);
    const body = texts.join('\n\n');

    // 一个 prompt 内多次 Stop，只发新增前缀差；边界 ts 变了（跑了新工具/新 turn）→ 重置 prev 整段发
    const sentKey = `__stop_sent_${(data.session_id || '').slice(0, 8)}`;
    sessionState.load();
    const slot = sessionState.data[sentKey];
    const prev = slot && slot.boundaryTs === boundaryTs ? slot.body : '';
    const delta = body.startsWith(prev) ? body.slice(prev.length).trim() : body;

    const save = () => { sessionState.data[sentKey] = { body, boundaryTs, created_at: Date.now() }; sessionState.save(); };
    if (!delta) {
        if (slot) return null; // 无新增且已发过 → 跳过
        save();
        return buildCard('Claude 完成', '任务已完成，可以查看执行结果了', 'green', getStats());
    }
    save();
    const shown = delta.length > STOP_BODY_MAX ? '…（仅显示最新部分）\n\n' + delta.slice(-STOP_BODY_MAX) : delta;
    return buildCard('Claude 完成', shown, 'green', getStats());
}

/** API 错误真实文本：payload 不带时反扫 transcript 取最近一条 isApiErrorMessage 助手消息 */
function latestApiError(transcriptPath) {
    return findTail(transcriptPath, (d) =>
        d.type === 'assistant' && d.isApiErrorMessage ? getAssistantText(d) || undefined : undefined
    );
}

function handleStopFailure(data, getStats) {
    const error = data.error || 'unknown';
    const details = data.error_details || latestApiError(data.transcript_path) || '发生未知错误';

    const errorMap = {
        'rate_limit': 'API 频率限制',
        'authentication_failed': '认证失败',
        'billing_error': '计费错误',
        'server_error': '服务器错误',
        'max_output_tokens': '输出超长',
        'invalid_request': '请求无效'
    };
    const title = errorMap[error] || '异常退出';

    return buildCard(title, details, 'red', getStats());
}

// ── 飞书自建应用 API 发送卡片 ──────────────────────────────

/** 获取飞书自建应用 client 和 chatId，无配置则返回 null */
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

/** 发卡 + 注册回调路由：发送成功才记 sessionState；esc/interrupt 通用中断键在此统一注入 */
async function sendCard(app, card, { stateKey, sessionId, type, ptsDevice, responses = {} }) {
    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        sessionState.addNotification(stateKey, {
            session_id: sessionId,
            notification_type: type,
            pts_device: ptsDevice,
            created_at: Date.now(),
            responses: {
                ...responses,
                esc: { keys: '\x1b', label: 'Esc' },
                interrupt: { keys: '\x1b', label: '⛔ Interrupt' },
            },
        });
    } catch (err) {
        console.error('[feishu] 发送卡片失败:', err.message);
    }
}

/** 通过自建应用 API 发送普通卡片（Stop / StopFailure） */
async function sendFeishuAppCard(data, event, getStats) {
    const handler = { Stop: handleStop, StopFailure: handleStopFailure }[event];
    if (!handler) return;

    const card = handler(data, getStats);
    if (!card) return; // handler 返 null 即跳过（Stop 增量空时）

    const app = await getFeishuAppClient();
    if (!app) return;

    // 末尾补输入框（卡片直接回话）+ 中断按钮与终端 id 同行
    const ptsDevice = resolvePtsDevice(process.ppid);
    const sessionId = data.session_id || '';
    const stateKey = `feishu_${sessionId.substring(0, 8)}_${Date.now()}`;
    card.body.elements.push(inputEl(stateKey), escFooterRow(stateKey, ptsDevice));

    await sendCard(app, card, { stateKey, sessionId, type: event, ptsDevice });
}

// ── 权限卡片构建 ─────────────────────────────────────────

/** 反扫 transcript 取最近一次 tool_use 的 markdown 描述 */
function describeLatestTool(transcriptPath, fallback) {
    return findTail(transcriptPath, (d) => {
        if (d.type !== 'assistant') return undefined;
        const tool = (d.message?.content || []).find(b => b.type === 'tool_use');
        if (!tool) return undefined;
        const input = tool.input || {};
        if (tool.name === 'Bash' && input.command) {
            return `⚡ **Bash**\n\`\`\`\n${input.command}\n\`\`\`` + (input.description ? `\n${input.description}` : '');
        }
        if (input.file_path) {
            return `${({ Read: '📖', Edit: '✏️', Write: '📝' })[tool.name] || '🔧'} **${tool.name}**: \`${input.file_path}\``;
        }
        return `🔧 **${tool.name}**`;
    }) ?? fallback;
}

/** 从 pty 输出文件解析终端实际的 Yes/No 编号选项 */
function parsePermissionOptions(ptsDevice) {
    const m = ptsDevice?.match(/pts(\d+)/);
    if (!m) return [];
    let raw;
    try { raw = fs.readFileSync(`/tmp/claude-pty-output-${m[1]}`, 'utf8'); } catch { return []; }
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const opts = [];
    const re = /(\d+)\.\s*(.+)/g;
    let mm;
    while ((mm = re.exec(clean)) !== null) {
        const text = mm[2].trim().split(/\r|\n/)[0].trim();
        if (/^(Yes|No)/i.test(text)) opts.push({ num: mm[1], text });
    }
    return opts;
}

/** 由解析到的选项生成按钮 + 回调键；解析失败回退到通用 允许/会话/拒绝/全局 按钮 */
function buildPermissionButtons(parsedOptions) {
    if (!parsedOptions.length) {
        return {
            buttons: [
                { text: '✅ 允许一次', actionType: 'opt_1', color: 'green' },
                { text: '🔓 会话允许', actionType: 'opt_2', color: 'default' },
                { text: '❌ 拒绝', actionType: 'opt_no', color: 'red' },
                { text: '🔓 全局允许', actionType: 'bypass', color: 'default' },
            ],
            responses: {
                opt_1: { keys: '1', label: '已允许' },
                opt_2: { keys: '2', label: '会话允许' },
                opt_no: { keys: '\x1b', label: '已拒绝' },
                bypass: { keys: '1', label: '全局允许' },
            },
        };
    }
    const buttons = parsedOptions.map(o => ({
        text: `${o.num}. ${o.text}`,
        actionType: `opt_${o.num}`,
        color: /^yes/i.test(o.text) ? 'green' : /^no/i.test(o.text) ? 'red' : 'default',
    }));
    buttons.push({ text: '🔓 全局允许', actionType: 'bypass', color: 'default' });
    const responses = { bypass: { keys: '1', label: '全局允许' } };
    parsedOptions.forEach(o => { responses[`opt_${o.num}`] = { keys: o.num, label: o.text }; });
    return { buttons, responses };
}

/** bypass 下 PreToolUse 不触发，从 transcript 检测 AskUserQuestion 并委托 claude-ask 发选择卡。已处理返 true */
async function tryAskUserQuestion(app, data, { sessionPrefix, sessionId }) {
    const askInput = extractAskUserQuestion(data.transcript_path);
    const questions = Array.isArray(askInput?.questions) ? askInput.questions : [];
    if (!questions.length) return false;

    const { sendSingleSelectCard, sendMultiSelectCard, sendMultiQuestionFirstCard } = require('./claude-ask');
    questions.forEach(q => { q._contextText = askInput._contextText || ''; });
    const ptsDevice = resolvePtsDevice(process.ppid);
    const stateKey = `feishu_ask_${sessionPrefix}_${Date.now()}`;

    if (questions.length > 1) {
        await sendMultiQuestionFirstCard(app, questions, stateKey, ptsDevice, sessionId, 'AskUserQuestion');
    } else if (questions[0].multiSelect) {
        await sendMultiSelectCard(app, questions[0], stateKey, ptsDevice, sessionId, 'AskUserQuestion');
    } else {
        await sendSingleSelectCard(app, questions[0], stateKey, ptsDevice, sessionId, 'AskUserQuestion');
    }
    return true;
}

/** 飞书交互卡片（Notification 事件，带回调按钮）。main 已过滤 idle/elicitation，只剩 permission_prompt */
async function sendFeishuInteractiveCard(data, getStats) {
    const app = await getFeishuAppClient();
    if (!app) return;

    const sessionId = data.session_id || '';
    const sessionPrefix = sessionId.substring(0, 8);

    // 30s 内 ask-handler（PreToolUse）已发过选择卡 → 跳过重复
    sessionState.load();
    const hasRecentAsk = Object.entries(sessionState.data)
        .some(([k, v]) => k.startsWith(`feishu_ask_${sessionPrefix}`) && Date.now() - (v.created_at || 0) < 30000);
    if (hasRecentAsk) return;

    if (await tryAskUserQuestion(app, data, { sessionPrefix, sessionId })) return;

    const ptsDevice = resolvePtsDevice(process.ppid);
    const stateKey = `feishu_${sessionPrefix}_${Date.now()}`;
    const toolDesc = describeLatestTool(data.transcript_path, data.message || '需要你的操作');
    const { buttons, responses } = buildPermissionButtons(parsePermissionOptions(ptsDevice));

    const btns = buttons.map(b => ({ text: b.text, actionType: b.actionType, type: b.color === 'red' ? 'danger' : b.color === 'green' ? 'primary' : 'default' }));
    const card = card2({
        template: 'orange',
        title: '权限确认',
        tags: statsTags(getStats()),
        elements: [
            ...parseMarkdownToElements(toolDesc),
            buttonRow(btns, stateKey),
            inputEl(stateKey),
            footer('claude', ptsDevice),
        ],
    });
    await sendCard(app, card, { stateKey, sessionId, type: data.notification_type || '', ptsDevice, responses });
}

// ── 主流程 ───────────────────────────────────────────────

async function main() {
    const data = await readStdin();
    const event = data.hook_event_name;
    if (!event) return;

    if (!envConfig.getFeishuAppConfig().enabled) return;

    // 登记 tmux 会话名 → 当前 transcript，供 ccback 按会话精确定位（同目录多会话也不混）。
    // SessionStart 让会话一启动/clear/compact 就登记；空否交由 ccback 读 transcript 内容判断
    const tmuxPts = resolvePtsDevice(process.ppid);
    if (tmuxPts?.startsWith('tmux:') && data.transcript_path) {
        try { fs.writeFileSync(`/tmp/claude-tmux-${tmuxPts.slice(5).split(':')[0]}.json`, JSON.stringify({ transcript: data.transcript_path })); } catch {}
    }

    // 懒求值：优先用 statusLine 旁路落盘的官方成本/时长（与状态栏同源），无则回退 transcript 时长
    let statsVal, statsDone = false;
    const getStats = () => {
        if (!statsDone) {
            statsVal = readOfficialStats(data.session_id) || parseSessionStats(data.transcript_path) || {};
            statsDone = true;
        }
        return statsVal;
    };

    const tasks = [];
    if (event === 'Notification') {
        const type = data.notification_type || '';
        if (type === 'permission_prompt') {
            // bypass 模式跳过（Notification payload 不带 mode，看 transcript）
            if (isBypassMode(data)) return;
            const ptsDevice = resolvePtsDevice(process.ppid);
            sessionState.load();
            const meta = sessionState.data['__meta__'] || {};
            const autoDevices = meta.autoApproveDevices || [];
            if (autoDevices.includes(ptsDevice)) {
                const { injectKeys } = require('../lib/terminal-inject');
                injectKeys(ptsDevice, '2').catch(() => {});
                return;
            }
        }
        if (type !== 'idle_prompt' && type !== 'elicitation_dialog') {
            tasks.push(sendFeishuInteractiveCard(data, getStats));
        }
    } else {
        tasks.push(sendFeishuAppCard(data, event, getStats));
    }

    if (tasks.length > 0) {
        await Promise.allSettled(tasks);
    }
}

main().catch(err => {
    console.error('Hook handler error:', err.message);
    process.exit(0); // 不要阻塞 Claude
});
