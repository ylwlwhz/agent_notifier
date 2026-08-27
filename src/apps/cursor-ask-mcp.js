/**
 * Cursor「向用户提问」MCP 服务 —— 把 IDE 选择题这个死角换成一条能远程作答的通路。
 *
 * 背景（实测结论，别再走回头路）：IDE 自带的交互式选择题（AskQuestion）不触发任何 hook，
 * 官方 18 个事件里也没有「agent 正在等用户回答」这一类；它还不结束本轮，所以 stop 不触发、
 * 完成卡不会发。人在外面既看不到问题也无法回答，会话就那么静止着。
 *
 * 但 MCP 工具调用是【有返回值】的：可以在自己的进程里阻塞着等飞书那边点一下，再把答案
 * 作为工具结果交回 agent —— 不需要「deny + agent_message」那种歪招，agent 拿到的就是
 * 一次正常的工具结果。
 *
 * 唯一的硬约束是超时：IDE 里 tools/call 上限约 60 分钟（CLI/ACP 那条路是硬编码 60s，
 * 且 notifications/progress 不会续期，官方论坛已确认）。所以默认只等 50 分钟留足余量；
 * 等不到就返回一段指引，让 agent 退回「正文列选项 + 结束本轮」—— 那条路由完成卡的
 * 输入框接手，窗口可长达 24 小时。
 *
 * 协议是手写的零依赖 stdio JSON-RPC：只需要 initialize / tools/list / tools/call，
 * 引 SDK 进来纯属给每次启动增加模块加载时间（网络文件系统上尤其贵）。
 *
 * 注册见 scripts/setup-cursor-mcp.js。
 */

'use strict';

const readline = require('readline');
const path = require('path');

// send() 专用的真实 stdout 入口，由 protectStdout 抢在改道之前存下
let rawStdoutWrite = null;

/**
 * 与 hook 同一个坑：stdout 是给 Cursor 读的协议通道，混进任何一行日志都会让它解析失败。
 * env-config 打「✅ 环境变量加载成功」、dotenv 与飞书 SDK 也各有输出，所以整体改道 stderr，
 * 只留 send() 一个真正的出口。
 *
 * 只在【作为主模块运行时】调用，绝不能放在模块顶层：被 require 时改道会把宿主进程的
 * stdout 一起劫持（实测把 node --test 的报告输出搅成乱码）。
 */
function protectStdout() {
    if (rawStdoutWrite) return;
    rawStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
}

const SERVER_NAME = 'agent-notifier-ask';
const SERVER_VERSION = '1.0.0';
const FALLBACK_PROTOCOL = '2025-06-18';

// 默认 50 分钟：IDE 的 tools/call 上限约 60 分钟，留 10 分钟余量。
// 别贴着 60 调 —— 撞上上限时 Cursor 报的是 MCP error -32001，用户只看到「工具失败」。
const DEFAULT_TIMEOUT_SEC = 3000;

function timeoutMs() {
    const n = parseFloat(process.env.CURSOR_ASK_TIMEOUT_SEC);
    return (Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC) * 1000;
}

function log(...args) {
    console.error('[cursor-ask-mcp]', ...args);
}

function send(message) {
    const line = JSON.stringify(message) + '\n';
    if (rawStdoutWrite) rawStdoutWrite(line);
    else process.stdout.write(line);
}

function reply(id, result) {
    if (id === undefined || id === null) return; // 通知没有 id，不该回
    send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
    if (id === undefined || id === null) return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── 工具定义 ─────────────────────────────────────────────────────────────────

const ASK_TOOL = {
    name: 'ask_user',
    description: [
        '通过飞书卡片向用户提问，并【阻塞等待】他的回答（默认最多 50 分钟）。',
        '当你需要用户在若干方案之间做决定、或需要只有他才能提供的信息时，用这个工具。',
        '',
        '重要：不要使用 IDE 内置的交互式选择题组件（AskQuestion）——它不触发任何 hook，',
        '用户在手机上既看不到问题也无法回答，会话会一直静止。这个工具就是它的替代品。',
        '',
        '返回值是用户的选择或自定义回答；若他没在时限内回答，返回值会指引你改用',
        '「把选项编号写进正文 + 结束本轮」的方式（那条通路的等待窗口更长）。',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: '问题正文，支持 markdown。把「为什么需要你决定」讲清楚。',
            },
            options: {
                type: 'array',
                items: { type: 'string' },
                description: '候选项（可选）。给了就渲染成按钮，用户点一下即可，不必打字。',
            },
            context: {
                type: 'string',
                description: '补充背景（可选），渲染在问题上方。',
            },
        },
        required: ['question'],
    },
};

// ── ask_user 实现 ────────────────────────────────────────────────────────────

/** 把裁决翻译成给 agent 看的工具结果文本 */
function describeAnswer(decision, options = []) {
    if (!decision) return null;
    if (decision.cancelled) {
        return '用户取消了这次提问。不要重复问同一个问题 —— 请按你自己的判断选一个最合理的'
            + '方案继续，并在正文里说明你选了哪个、为什么。';
    }
    const answer = String(decision.answer || '').trim();
    if (!answer) return null;
    const idx = options.findIndex((opt) => String(opt) === answer);
    return idx >= 0
        ? `用户选择了第 ${idx + 1} 个选项：${answer}`
        : `用户的回答：${answer}`;
}

/** 超时后给 agent 的指引：别重问，退回那条窗口更长的通路 */
function timeoutGuidance(waitMs) {
    const min = Math.max(1, Math.round(waitMs / 60000));
    return [
        `用户没有在 ${min} 分钟内回答。`,
        '不要再调用 ask_user 重问 —— 改成把问题和候选项【编上号写进正文】，然后结束本轮。',
        '本轮结束时会推一张带输入框的完成卡，那条通路的等待窗口长得多（可达 24 小时），',
        '用户回一个编号就能继续。',
    ].join('\n');
}

/** 没有飞书通路时的统一退路：如实说明 + 指引改用正文提问 */
function noChannelGuidance(reason) {
    return `${reason}请把问题和候选项编号写进正文，然后结束本轮，让用户从完成卡回复。`;
}

async function askUser({ question, options = [], context = '' }) {
    const waitMs = timeoutMs();

    // 到这里才 require：这些模块（尤其飞书传输层）加载不便宜，
    // 而 initialize / tools/list 根本用不到它们
    require('../lib/env-config');
    const { sessionState } = require('../lib/session-state');
    const { decisionBridge, newDecisionId } = require('../lib/decision-bridge');
    const cards = require('./cursor-cards');

    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
        return noChannelGuidance('飞书未配置（缺 FEISHU_APP_ID / FEISHU_APP_SECRET），无法远程提问。');
    }

    const { createLarkHttpClient } = require('../channels/feishu/feishu-client');
    const { resolveFeishuChatId } = require('../channels/feishu/resolve-chat-id');
    const client = createLarkHttpClient({ appId, appSecret });
    const chatId = await resolveFeishuChatId({
        preferredChatId: process.env.FEISHU_CHAT_ID,
        larkClient: client,
    });
    if (!chatId) {
        return noChannelGuidance('解析不到飞书会话，无法远程提问。');
    }

    const list = (Array.isArray(options) ? options : [])
        .map((o) => String(o == null ? '' : o).trim())
        .filter(Boolean);
    const decisionId = newDecisionId('cursorask');
    const stateKey = `feishu_cursor_ask_${Date.now()}`;
    const responses = cards.askResponses(list);
    const projectName = path.basename(process.env.CURSOR_PROJECT_DIR || '') || '';

    decisionBridge.open(decisionId, {
        host: 'cursor',
        event: 'mcp_ask_user',
        project: projectName,
        timeoutMs: waitMs,
    });

    // 必须先写 state 再发卡：反过来会留一个「卡已可点、通知还没落盘」的竞态窗口
    // （就是一次飞书 API 往返），用户手快就会撞上假的「卡片已过期」。
    sessionState.addNotification(stateKey, {
        host: 'cursor',
        session_id: `cursor_ask_${decisionId}`,
        notification_type: 'cursor_mcp_ask',
        pts_device: null,          // MCP 提问没有终端，裁决靠 decision-bridge 回流
        decision_id: decisionId,
        created_at: Date.now(),
        responses,
        text_response: { field: 'answer' },
    });

    let messageId = null;
    try {
        const resp = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify(cards.buildAskCard({
                    question, options: list, context, stateKey, timeoutMs: waitMs, projectName,
                })),
            },
        });
        messageId = resp?.data?.message_id || null;
    } catch (err) {
        log('发送提问卡失败:', err.message);
        // 卡片没发出去 = 没人能作答，绝不能在这里阻塞
        sessionState.removeNotification(stateKey);
        decisionBridge.close(decisionId);
        return noChannelGuidance(`提问卡没发出去（${err.message}）。`);
    }

    const decision = await decisionBridge.wait(decisionId, { timeoutMs: waitMs });
    decisionBridge.close(decisionId);
    try { sessionState.removeNotification(stateKey); } catch { /* 清理尽力而为 */ }

    const answered = describeAnswer(decision, list);

    // 收敛卡片：撤掉交互组件，把结果写在卡上。不然几十分钟后还能点，点了却「无人在等」。
    if (messageId) {
        try {
            await client.im.message.patch({
                path: { message_id: messageId },
                data: {
                    content: JSON.stringify(cards.buildSettledAskCard({
                        question,
                        answered: !!answered,
                        statusText: answered ? `✅ ${answered}` : '⏳ **已超时** — 未收到回答，已交回正文提问',
                    })),
                },
            });
        } catch (err) {
            log('收敛提问卡失败:', err.message);
        }
    }

    return answered || timeoutGuidance(waitMs);
}

// ── JSON-RPC 分发 ────────────────────────────────────────────────────────────

async function handle(msg) {
    const { id, method, params } = msg || {};

    switch (method) {
        case 'initialize':
            return reply(id, {
                // 只用到最基础的 tools 能力，客户端声明什么版本我们都能满足，原样回它的
                protocolVersion: params?.protocolVersion || FALLBACK_PROTOCOL,
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            });

        case 'notifications/initialized':
        case 'initialized':
            return; // 通知，无需回应

        case 'ping':
            return reply(id, {});

        case 'tools/list':
            return reply(id, { tools: [ASK_TOOL] });

        case 'tools/call': {
            if (params?.name !== ASK_TOOL.name) {
                return replyError(id, -32602, `未知工具: ${params?.name}`);
            }
            const args = params.arguments || {};
            if (!String(args.question || '').trim()) {
                return reply(id, { isError: true, content: [{ type: 'text', text: 'question 不能为空' }] });
            }
            try {
                const text = await askUser({
                    question: String(args.question),
                    options: args.options,
                    context: args.context ? String(args.context) : '',
                });
                return reply(id, { content: [{ type: 'text', text }] });
            } catch (err) {
                log('ask_user 失败:', err.message);
                // 绝不能让工具调用悬着：如实回错误，agent 还能改用正文提问
                return reply(id, {
                    isError: true,
                    content: [{ type: 'text', text: noChannelGuidance(`远程提问失败（${err.message}）。`) }],
                });
            }
        }

        default:
            // 未实现的方法要如实回 -32601，别静默 —— 否则客户端会一直等
            return replyError(id, -32601, `未实现的方法: ${method}`);
    }
}

function main() {
    protectStdout();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            return log('收到非法 JSON，已忽略');
        }
        // 刻意不 await：一次 ask_user 会阻塞几十分钟，期间必须还能响应 ping / tools/list
        Promise.resolve(handle(msg)).catch((err) => {
            log('处理请求出错:', err.message);
            replyError(msg?.id, -32603, err.message);
        });
    });
    rl.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = {
    handle,
    protectStdout,
    askUser,
    describeAnswer,
    timeoutGuidance,
    noChannelGuidance,
    timeoutMs,
    ASK_TOOL,
    DEFAULT_TIMEOUT_SEC,
};
