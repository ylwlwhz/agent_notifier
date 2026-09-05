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
 * 超时是这条路上最容易踩空的地方。Cursor 的 MCP 客户端有【两道】时限，它自己的日志
 * （mcpMeta.event=mcp_tool_call_timeout）把常量写得很清楚：
 *
 *   idleTimeoutMs     = 120000    连接上 120 秒没动静，这次 tools/call 就被判死
 *                                 （MCP error -32001），与总时长无关
 *   maxTotalTimeoutMs = 3600000   单次调用的硬顶，心跳也顶不过去
 *
 * 所以【等待期间必须发心跳】：每 CURSOR_ASK_HEARTBEAT_SEC 秒回一条 notifications/progress
 * （带客户端在 tools/call 的 _meta.progressToken 里给的那个 token），idle 计时器就会被
 * 重置。这是实测过的：不发心跳一律死在第 120 秒；每 20 秒发一次，单次调用活到 300 秒仍
 * 正常返回、且客户端没发 notifications/cancelled。
 *
 * 心跳只解决 idle，解决不了 60 分钟硬顶，所以仍然要【分段续等】：每次调用最多阻塞
 * CURSOR_ASK_CHUNK_SEC（默认 50 分钟，给硬顶留 10 分钟余量），到点若还没答案就返回一个
 * pending_id，并明确要求 agent 立刻再调 ask_user_wait 继续等 —— 总窗口可达
 * CURSOR_ASK_TIMEOUT_SEC（默认 24 小时）。
 *
 * 万一客户端没给 progressToken（心跳无处可发），单段就退化成 90 秒，抢在 idle 判死之前
 * 把控制权交还 agent，让它靠 ask_user_wait 接力 —— 慢，但不会静默失联。
 *
 * 分段之所以安全，是因为裁决走的是【文件】而不是活的通道：用户在两段之间回答，答案落盘，
 * 下一段 wait() 读文件照样拿到，不会漏。
 *
 * 总窗口也到期了才放弃，返回指引让 agent 退回「正文列选项 + 结束本轮」——
 * 那条路由完成卡的输入框接手。
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

// 总等待窗口，默认 24 小时 —— 与完成卡的续写窗口（CURSOR_FOLLOWUP_TIMEOUT_SEC）对齐。
// 两条通路给的窗口不一致会很难解释：同一个人、同一部手机，凭什么选择题只能等半天。
const DEFAULT_TIMEOUT_SEC = 86400;

// 单次 tools/call 只阻塞这么久，默认 50 分钟。
// 别贴着 60 分钟调 —— IDE 的上限就在那附近，撞上时 Cursor 报 MCP error -32001，
// 用户只会看到「工具失败」，而不是「还在等你」。
const DEFAULT_CHUNK_SEC = 3000;

// 心跳间隔，默认 20 秒。客户端的 idle 上限是 120 秒，取它的六分之一：
// 网络文件系统上偶尔卡一两拍也还有余量。
const DEFAULT_HEARTBEAT_SEC = 20;

// 客户端侧的两个硬常量（来自 Cursor 自己的 mcpMeta 日志，不是猜的）
const CLIENT_IDLE_TIMEOUT_MS = 120 * 1000;
const CLIENT_MAX_CALL_MS = 60 * 60 * 1000;
// 单段与硬顶之间留的余量：网络往返 + agent 侧调度都要时间
const CALL_MARGIN_MS = 5 * 60 * 1000;
// 拿不到 progressToken 时的单段上限：必须明显短于 idle 上限
const NO_TOKEN_CHUNK_MS = 90 * 1000;

// 归属过滤的结论：一个 MCP 进程只服务一个工作区，算一次就定了
let workspaceAllowedCache = null;

/**
 * 这个 MCP 进程服务的工作区，在 `CURSOR_NOTIFY_ROOTS` 白名单里吗。
 *
 * 为什么这里只能按路径判：MCP 进程**拿不到任何账号信息**。实测它的环境里只有
 * `WORKSPACE_FOLDER_PATHS`（还有 VSCODE_* / CURSOR_LAYOUT 之类），没有 hook payload
 * 里那个 `user_email`。所以共享 root 的机器上，「同事的 agent 调 ask_user」这条路
 * 只能靠工作区路径拦住。
 *
 * 拦不住的后果实测过：GY_2 上同时跑着 5 个本服务进程，其中 4 个属于同事的窗口。
 * 他的 agent 调一次 ask_user，卡片就发到你手机上，他的会话则阻塞最长 24 小时，
 * 而他只看到 agent 卡住不动。
 *
 * 判不出工作区就当【不是自己的】：宁可让本服务在这个窗口里不可用，
 * 也不能把别人的会话挂在你的飞书上。
 */
function workspaceAllowed() {
    if (workspaceAllowedCache !== null) return workspaceAllowedCache;

    require('../lib/env-config');
    const { parseCursorControlConfig, underRoot } = require('../adapters/cursor/control-policy');
    const roots = parseCursorControlConfig().owner.roots;
    if (!roots.length) {
        workspaceAllowedCache = true;   // 没配白名单 = 单人机器，不过滤
        return true;
    }

    const folders = String(process.env.WORKSPACE_FOLDER_PATHS || '')
        .split(path.delimiter)
        .map((s) => s.trim())
        .filter(Boolean);
    // every 而不是 some：多根工作区里只要混进一个别人的目录，就不该放行
    workspaceAllowedCache = folders.length > 0 && folders.every((f) => roots.some((r) => underRoot(f, r)));
    if (!workspaceAllowedCache) {
        log(`工作区不在 CURSOR_NOTIFY_ROOTS 内，本进程不提供 ask_user：${folders.join(', ') || '未知'}`);
    }
    return workspaceAllowedCache;
}

/** 只给测试用：真实进程里工作区一辈子不变，没有重算的场景 */
function resetWorkspaceAllowed() {
    workspaceAllowedCache = null;
}

function timeoutMs() {
    const n = parseFloat(process.env.CURSOR_ASK_TIMEOUT_SEC);
    return (Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC) * 1000;
}

function chunkMs() {
    const n = parseFloat(process.env.CURSOR_ASK_CHUNK_SEC);
    const chunk = (Number.isFinite(n) && n > 0 ? n : DEFAULT_CHUNK_SEC) * 1000;
    // 分段既不该比总窗口长，也不能顶到客户端的单次调用硬顶
    return Math.min(chunk, timeoutMs(), CLIENT_MAX_CALL_MS - CALL_MARGIN_MS);
}

function heartbeatMs() {
    const n = parseFloat(process.env.CURSOR_ASK_HEARTBEAT_SEC);
    const beat = (Number.isFinite(n) && n > 0 ? n : DEFAULT_HEARTBEAT_SEC) * 1000;
    // 配得比 idle 上限还长等于没配
    return Math.min(beat, CLIENT_IDLE_TIMEOUT_MS / 2);
}

/** 本次调用能安全阻塞多久：有 token 才能靠心跳续命，否则只能抢在 idle 判死前返回 */
function sliceMsFor(progressToken) {
    return progressToken === undefined || progressToken === null
        ? Math.min(NO_TOKEN_CHUNK_MS, timeoutMs())
        : chunkMs();
}

// pending_id → 这一问的现场。MCP 服务进程在 Cursor 会话期间常驻，所以放内存里就够；
// 进程真被重启了，那些卡也已经没人接了，用户点了会看到「未生效」——那是诚实的。
const pending = new Map();

// JSON-RPC 请求 id → pending_id。notifications/cancelled 只带请求 id，
// 没这张表就无法知道该中止哪一次等待。
const byRequestId = new Map();

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

/**
 * 心跳。这不是「进度展示」，而是保命信号：客户端 120 秒收不到任何东西就把本次
 * tools/call 判死。progressToken 是客户端在 tools/call 的 _meta 里给的，必须原样回。
 */
function sendProgress(progressToken, progress, message) {
    if (progressToken === undefined || progressToken === null) return false;
    send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken, progress, message },
    });
    return true;
}

function replyError(id, code, message) {
    if (id === undefined || id === null) return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── 工具定义 ─────────────────────────────────────────────────────────────────

const ASK_TOOL = {
    name: 'ask_user',
    description: [
        '通过飞书卡片向用户提问，并【阻塞等待】他的回答（单次最多 50 分钟，续等后总窗口 24 小时）。',
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

const WAIT_TOOL = {
    name: 'ask_user_wait',
    description: [
        '继续等待某次 ask_user 的回答。',
        '当 ask_user（或本工具）返回「还没收到回答，pending_id=...」时，立刻用同一个 pending_id',
        '再调一次本工具即可继续等 —— 单次调用不会超过 MCP 的时长上限，这样总等待窗口可以很长。',
        '除非你决定不再等（那就把问题写进正文并结束本轮），否则不要跳过这一步。',
    ].join('\n'),
    inputSchema: {
        type: 'object',
        properties: {
            pending_id: { type: 'string', description: 'ask_user 返回的 pending_id' },
        },
        required: ['pending_id'],
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

/** 人类可读的时长，用于给 agent 和卡片写文案 */
function humanDuration(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${Math.max(1, min)} 分钟`;
    const h = Math.round(min / 60 * 10) / 10;
    return `${h} 小时`;
}

/** 总窗口到期后给 agent 的指引：别重问，退回那条由完成卡承载的通路 */
function timeoutGuidance(waitMs) {
    return [
        `用户没有在 ${humanDuration(waitMs)} 内回答。`,
        '不要再调用 ask_user 重问 —— 改成把问题和候选项【编上号写进正文】，然后结束本轮。',
        '本轮结束时会推一张带输入框的完成卡，用户回一个编号就能继续。',
    ].join('\n');
}

/**
 * 单段等完但总窗口还没到：要求 agent 立刻续等。
 *
 * 措辞必须是明确的「下一步就做这个」，不能含糊 —— 含糊的话 agent 可能自己往下跑，
 * 用户几小时后点了卡片却没人接。同时给出「不想等就正文提问」的另一条明路。
 */
function pendingGuidance(pendingId, remainingMs) {
    return [
        '还没收到用户的回答，卡片仍然有效（他可能不在电脑前）。',
        `pending_id=${pendingId}`,
        '',
        `下一步：立刻调用 ask_user_wait({ pending_id: "${pendingId}" }) 继续等，`,
        `剩余等待窗口约 ${humanDuration(remainingMs)}。`,
        '（单次调用不能超过 MCP 的时长上限，所以长等待要靠这样一段段续。）',
        '',
        '如果你决定不再等，就把问题和候选项编号写进正文并结束本轮，让用户从完成卡回复。',
    ].join('\n');
}

/** 没有飞书通路时的统一退路：如实说明 + 指引改用正文提问 */
function noChannelGuidance(reason) {
    return `${reason}请把问题和候选项编号写进正文，然后结束本轮，让用户从完成卡回复。`;
}

async function askUser({ question, options = [], context = '', progressToken, requestId }) {
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

    // 提问正文里的本机图片传上去换成 image_key —— 「这两张渲染哪个对」这类问题，
    // 看不到图就没法答。这里不心疼这次上传：本调用接下来要阻塞几十分钟
    const { embedImages } = require('../lib/card-images');
    const shown = {};
    for (const [field, value] of Object.entries({ question, context })) {
        shown[field] = (await embedImages(value, {
            client,
            cwd: process.env.CURSOR_PROJECT_DIR || process.cwd(),
            log: (msg) => log(msg),
        })).text;
    }

    let messageId = null;
    try {
        const resp = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify(cards.buildAskCard({
                    question: shown.question,
                    options: list,
                    context: shown.context,
                    stateKey,
                    timeoutMs: waitMs,
                    projectName,
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

    // 登记现场，之后每次 ask_user_wait 都在同一个 decisionId 上继续等
    const pendingId = decisionId;
    if (requestId !== undefined && requestId !== null) byRequestId.set(String(requestId), pendingId);
    pending.set(pendingId, {
        decisionId,
        stateKey,
        messageId,
        client,
        // 存换好 image_key 的那份：收敛版卡片会重渲染正文，用原始路径会让图在事后消失
        question: shown.question,
        options: list,
        deadline: Date.now() + waitMs,
        totalMs: waitMs,
    });

    return waitChunk(pendingId, progressToken);
}

/**
 * 收摊：关掉决策通道、清掉通知、把卡片收敛成只读态。
 * statusText 给调用方覆盖卡上那行状态（取消场景要说清「为什么没生效」）。
 */
async function finish(ask, answered, statusText) {
    const { decisionBridge } = require('../lib/decision-bridge');
    const { sessionState } = require('../lib/session-state');
    const cards = require('./cursor-cards');

    decisionBridge.close(ask.decisionId);
    try { sessionState.removeNotification(ask.stateKey); } catch { /* 清理尽力而为 */ }
    pending.delete(ask.decisionId);

    // 不收敛的话，几小时后卡片还能点，点了却「无人在等」
    if (!ask.messageId) return;
    try {
        await ask.client.im.message.patch({
            path: { message_id: ask.messageId },
            data: {
                content: JSON.stringify(cards.buildSettledAskCard({
                    question: ask.question,
                    answered: !!answered,
                    statusText: statusText || (answered
                        ? `✅ ${answered}`
                        : '⏳ **已超时** — 未收到回答，已交回正文提问'),
                })),
            },
        });
    } catch (err) {
        log('收敛提问卡失败:', err.message);
    }
}

/**
 * 阻塞等一段，期间按 heartbeatMs 发心跳把客户端的 idle 计时器顶回去。
 *
 * 心跳失败（stdout 已断）就停发：这时候连接本身没了，继续发只是徒劳。
 */
async function waitWithHeartbeat(ask, sliceMs, progressToken) {
    const { decisionBridge } = require('../lib/decision-bridge');
    const beat = heartbeatMs();
    let ticks = 0;

    const timer = progressToken === undefined || progressToken === null ? null : setInterval(() => {
        ticks += 1;
        try {
            sendProgress(progressToken, ticks, `等待用户在飞书上回答…已 ${Math.round(ticks * beat / 1000)}s`);
        } catch (err) {
            log('心跳发送失败，停止心跳:', err.message);
            clearInterval(timer);
        }
    }, beat);

    try {
        return await decisionBridge.wait(ask.decisionId, {
            timeoutMs: sliceMs,
            shouldAbort: () => !!ask.cancelled,
        });
    } finally {
        if (timer) clearInterval(timer);
    }
}

/**
 * 等一段（不超过 sliceMsFor(progressToken)），据结果返回：答案 / 续等指引 / 最终超时指引。
 *
 * 分段的正确性来自「裁决是文件」：用户在两段之间回答，答案落盘，下一段 wait() 照样读到。
 * 所以这里【不能】在段间收敛卡片，也不能关掉决策通道。
 */
async function waitChunk(pendingId, progressToken) {
    const ask = pending.get(pendingId);
    if (!ask) {
        return noChannelGuidance(`pending_id=${pendingId} 已经结束或不存在（可能已被回答、已超时，或服务重启过）。`);
    }

    const { decisionBridge } = require('../lib/decision-bridge');
    const remaining = ask.deadline - Date.now();
    const slice = Math.min(sliceMsFor(progressToken), Math.max(0, remaining));

    const decision = slice > 0
        ? await waitWithHeartbeat(ask, slice, progressToken)
        : decisionBridge.read(ask.decisionId); // 窗口已尽，最后瞄一眼免得错过刚落盘的答案

    // 客户端已放弃这次调用（IDE 里被停止 / 撞上硬顶）：返回值没人收，
    // 但卡片必须收敛，否则用户几小时后还在往一个死掉的调用里作答。
    if (ask.cancelled) {
        const late = describeAnswer(decisionBridge.read(ask.decisionId), ask.options);
        await finish(ask, null, late
            ? '⛔ **已取消** — 你的回答到得比 IDE 放弃等待更晚，没能交回；请从完成卡重发'
            : '⛔ **已取消** — IDE 侧已终止这次提问');
        return '本次提问已被 IDE 取消。';
    }

    const answered = describeAnswer(decision, ask.options);
    if (answered) {
        await finish(ask, answered);
        return answered;
    }

    const left = ask.deadline - Date.now();
    if (left > 0) return pendingGuidance(pendingId, left);

    await finish(ask, null);
    return timeoutGuidance(ask.totalMs);
}

/** 客户端放弃某次 tools/call：中止对应的等待，让 waitChunk 去收摊 */
function cancelRequest(requestId) {
    const pendingId = byRequestId.get(String(requestId));
    if (!pendingId) return false;
    const ask = pending.get(pendingId);
    if (!ask) return false;
    ask.cancelled = true;
    log(`客户端取消了请求 ${requestId}，中止 pending_id=${pendingId} 的等待`);
    return true;
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

        case 'notifications/cancelled':
            // 客户端放弃了某次调用。不处理的话我们会一直等到分段到期，
            // 期间用户在飞书上的回答会被一个已经没人收的返回值吞掉。
            cancelRequest(params?.requestId);
            return;

        case 'ping':
            return reply(id, {});

        case 'tools/list':
            // 不属于自己的工作区就干脆不宣告工具：别人的 agent 看不见它，也就不会调它，
            // 这比等它调完再拒绝干净得多
            return reply(id, { tools: workspaceAllowed() ? [ASK_TOOL, WAIT_TOOL] : [] });

        case 'tools/call': {
            const args = params?.arguments || {};
            if (params?.name !== ASK_TOOL.name && params?.name !== WAIT_TOOL.name) {
                return replyError(id, -32602, `未知工具: ${params?.name}`);
            }
            // 万一 agent 手里还攥着上一次 tools/list 的缓存：给它一条能走的路，
            // 而不是报错（报错在用户那边显示成「工具失败」，什么也说明不了）
            if (!workspaceAllowed()) {
                return reply(id, {
                    content: [{
                        type: 'text',
                        text: '此工作区未启用 agent-notifier 远程提问。'
                            + '请把问题和候选项编上号写进正文，然后结束本轮，由用户直接回复。',
                    }],
                });
            }
            if (params.name === ASK_TOOL.name && !String(args.question || '').trim()) {
                return reply(id, { isError: true, content: [{ type: 'text', text: 'question 不能为空' }] });
            }
            if (params.name === WAIT_TOOL.name && !String(args.pending_id || '').trim()) {
                return reply(id, { isError: true, content: [{ type: 'text', text: 'pending_id 不能为空' }] });
            }
            // 心跳要发给这个 token；客户端每次调用给的 token 都不同，不能缓存复用
            const progressToken = params?._meta?.progressToken;
            const pendingId = params.name === WAIT_TOOL.name ? String(args.pending_id) : null;
            if (pendingId) byRequestId.set(String(id), pendingId);
            try {
                const text = params.name === WAIT_TOOL.name
                    ? await waitChunk(pendingId, progressToken)
                    : await askUser({
                        question: String(args.question),
                        options: args.options,
                        context: args.context ? String(args.context) : '',
                        progressToken,
                        requestId: id,
                    });
                return reply(id, { content: [{ type: 'text', text }] });
            } catch (err) {
                log('ask_user 失败:', err.message);
                // 绝不能让工具调用悬着：如实回错误，agent 还能改用正文提问
                return reply(id, {
                    isError: true,
                    content: [{ type: 'text', text: noChannelGuidance(`远程提问失败（${err.message}）。`) }],
                });
            } finally {
                byRequestId.delete(String(id));
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
    workspaceAllowed,
    resetWorkspaceAllowed,
    askUser,
    waitChunk,
    cancelRequest,
    describeAnswer,
    timeoutGuidance,
    pendingGuidance,
    noChannelGuidance,
    humanDuration,
    timeoutMs,
    chunkMs,
    heartbeatMs,
    sliceMsFor,
    sendProgress,
    pending,
    byRequestId,
    ASK_TOOL,
    WAIT_TOOL,
    DEFAULT_TIMEOUT_SEC,
    DEFAULT_CHUNK_SEC,
    DEFAULT_HEARTBEAT_SEC,
    CLIENT_IDLE_TIMEOUT_MS,
    CLIENT_MAX_CALL_MS,
    NO_TOKEN_CHUNK_MS,
};
