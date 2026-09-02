/**
 * Cursor Hook 统一处理器 —— Cursor 的飞书通知与远程控制入口。
 *
 * Cursor 的 hook 是【阻塞式】子进程：Cursor 把事件 JSON 写进 stdin，然后等我们在
 * stdout 上回一段 JSON 来决定它下一步做什么。这跟 Claude/Codex 完全不同——
 * 那两个宿主要靠 PTY 注入按键，Cursor 只要「让 hook 进程等飞书那边点一下」即可，
 * 不需要 pty-relay、不需要终端解析、也不存在注入失败。
 *
 * 处理的事件（默认注册见 scripts/setup-cursor-hooks.js）:
 *   beforeShellExecution / beforeMCPExecution  阻塞审批 → 回 permission
 *   preToolUse                                 同上（需 CURSOR_APPROVE_TOOLS 显式列名）
 *   stop / subagentStop                        完成卡 + 阻塞续写 → 回 followup_message
 *   afterAgentResponse                         助手正文，喂完成卡与实时摘要
 *   postToolUse / postToolUseFailure           实时执行摘要 + 会话中途补打提问引导
 *
 * 超时一律回落到宿主本地行为，绝不把 Cursor 永久挂住（见 control-policy）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sessionState } = require('../lib/session-state');
const { decisionBridge, newDecisionId } = require('../lib/decision-bridge');
const { sharedTmpPath } = require('../lib/tmp-dir');
const { translateCursorHook } = require('../adapters/cursor/hook-adapter');
const {
    parseCursorControlConfig,
    shouldAskApproval,
    shouldWaitFollowup,
    timeoutDecision,
    renderHookOutput,
    QUESTION_STEER_CONTEXT,
    QUESTION_STEER_REMINDER,
} = require('../adapters/cursor/control-policy');
const stallWatch = require('./cursor-stall-watch');
const cards = require('./cursor-cards');
const { resolveFeishuChatId } = require('../channels/feishu/resolve-chat-id');

// ── stdin / stdout ───────────────────────────────────────────────────────────

// emit() 专用的真实 stdout 写入口，由 protectStdout 抢在改道之前存下
let rawStdoutWrite = null;

/**
 * 本进程的 stdout 是给 Cursor 读的裁决 JSON 通道，混进任何一行日志都会让 Cursor
 * 把整段输出判为无效 JSON —— failClosed 时那等于直接拦下用户的操作。
 *
 * 只改 console.log 不够：实测飞书 SDK 会用 console.info 打 `[info]: [ 'client ready' ]`，
 * env-config 用 console.log 打「✅ 环境变量加载成功」，dotenv 还有自己的提示。
 * 所以直接把 process.stdout.write 整体改道 stderr（console.* 也都走它），
 * 只留 emit() 一个真正的出口。Cursor 的 Hooks 输出面板读 stderr，日志照样能看到。
 *
 * 必须在 require('env-config') 与飞书 SDK 之前调用。
 */
function protectStdout() {
    if (rawStdoutWrite) return;
    rawStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); } catch { done({}); }
        });
        process.stdin.on('error', () => done({}));
        setTimeout(() => done({}), 3000).unref();
    });
}

/** 唯一允许写 stdout 的地方（走 protectStdout 存下的真实入口，绕过改道） */
function emit(output) {
    const line = JSON.stringify(output || {}) + '\n';
    if (rawStdoutWrite) rawStdoutWrite(line);
    else process.stdout.write(line);
}

// ── 飞书 ─────────────────────────────────────────────────────────────────────

async function getFeishuApp() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return null;

    // 必须走工厂而不是 new Lark.Client：出网强制走代理的机器上 SDK 传输层会静默挂住
    const { createLarkHttpClient } = require('../channels/feishu/feishu-client');
    const client = createLarkHttpClient({ appId, appSecret });
    const chatId = await resolveFeishuChatId({
        preferredChatId: process.env.FEISHU_CHAT_ID,
        larkClient: client,
    });
    return chatId ? { client, chatId } : null;
}

async function sendCard(app, card) {
    const resp = await app.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    return resp?.data?.message_id || null;
}

/**
 * 发一张不需要等结果的卡：把卡片交给 detached 子进程，hook 立刻返回。
 *
 * hook 不返回 Cursor 就一直等，而纯通知卡发完没人再用它的 message_id —— 同步等一次
 * 飞书往返纯属让用户干等（远程机上实测这一等就是 10s，改 detached 后只剩 ~2s）。
 * 需要事后收敛卡片的链路（审批 / 等续写）不能走这里，它们要 message_id。
 */
function sendCardDetached(card) {
    if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) return false;
    try {
        const file = sharedTmpPath(`cursor-card-${Date.now()}-${process.pid}.json`);
        fs.writeFileSync(file, JSON.stringify(card), 'utf8');
        const child = require('child_process').spawn(
            process.execPath,
            [path.join(__dirname, 'cursor-send-card.js'), file],
            { detached: true, stdio: 'ignore', env: process.env }
        );
        child.unref();
        return true;
    } catch (err) {
        console.error('[cursor-hook] 无法启动发卡子进程:', err.message);
        return false;
    }
}

async function patchCard(app, messageId, card) {
    if (!messageId) return;
    await app.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
    });
}

// ── 本地缓冲：助手正文 + 实时摘要 ─────────────────────────────────────────────

function lastResponsePath(sessionKey) {
    return sharedTmpPath(`cursor-last-response-${sessionKey}.json`);
}

function liveBufferPath(sessionKey) {
    return sharedTmpPath(`cursor-live-${sessionKey}.jsonl`);
}

/** stop 事件的 payload 不带助手正文，只能靠 afterAgentResponse 先存下来 */
function recordLastResponse(sessionKey, text) {
    if (!text) return;
    try {
        fs.writeFileSync(lastResponsePath(sessionKey), JSON.stringify({ text, ts: Date.now() }), 'utf8');
    } catch { /* 正文只是锦上添花，写不进去也不该影响裁决 */ }
}

/** 读并清掉：一段正文只该出现在一张完成卡上 */
function consumeLastResponse(sessionKey) {
    const file = lastResponsePath(sessionKey);
    try {
        const { text } = JSON.parse(fs.readFileSync(file, 'utf8'));
        try { fs.unlinkSync(file); } catch { /* 并发消费，忽略 */ }
        return text || '';
    } catch { return ''; }
}

/** 追加一条实时摘要，并 spawn 一个 detached 的 debounce flush 子进程 */
function appendLive(sessionKey, entry) {
    const bufferPath = liveBufferPath(sessionKey);
    try {
        fs.appendFileSync(bufferPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch { return; }
    try {
        const child = require('child_process').spawn(
            process.execPath,
            [path.join(__dirname, 'cursor-live.js'), '--flush', bufferPath],
            { detached: true, stdio: 'ignore', env: process.env }
        );
        child.unref();
    } catch (err) {
        console.error('[cursor-hook] 无法启动 live flush:', err.message);
    }
}

// ── 阻塞式交互：发卡 → 等飞书 → 收敛卡片 ──────────────────────────────────────

/**
 * 发一张交互卡，阻塞等待飞书回传裁决，然后把卡片收敛成只读态。
 * 返回飞书给出的裁决，或 null 表示超时/发不出去（调用方据此回落）。
 *
 * 关键顺序：必须【先写 state 再发卡】。反过来会留一个「卡已可点、通知还没落盘」的
 * 竞态窗口（实测 1-5s，就是一次飞书 API 往返），用户手快就会撞上假的「卡片已过期」。
 */
/**
 * 同一会话只保留一张待回复的卡：新一轮开始前，把上一轮还挂着的那张收敛掉。
 *
 * 等待窗口长达 24h 时，每轮结束都会留下一个阻塞的 hook 进程和一张永久有效的卡。
 * 实测攒到 9 个（4 小时里每轮一个）—— 进程泄漏之外更糟的是：用户回复某张旧卡，
 * 续写会被注入到几小时前就结束的那一轮里。
 *
 * 写入裁决而不是硬杀进程：老 hook 会自己醒来、把卡片收敛成只读态、再正常退出。
 */
function supersedePrevious(event) {
    try {
        const stale = decisionBridge.listPending({
            sessionId: event.sessionId,
            event: event.meta.eventName,
        });
        for (const id of stale) decisionBridge.resolve(id, { superseded: true });
        if (stale.length) console.error(`[cursor-hook] 已收敛上一轮遗留的 ${stale.length} 张卡`);
    } catch (err) {
        console.error('[cursor-hook] 收敛旧卡失败:', err.message);
    }
}

async function askFeishu({ event, app, buildCard, buildSettled, responses, textResponse, notificationType, timeoutMs }) {
    supersedePrevious(event);

    const decisionId = newDecisionId('cursor');
    const stateKey = `feishu_cursor_${event.sessionKey}_${Date.now()}`;

    decisionBridge.open(decisionId, {
        host: 'cursor',
        event: event.meta.eventName,
        session_id: event.sessionId,
        project: event.meta.projectName,
        // 让 listener 的按龄清理知道「这个请求要等到什么时候」，
        // 否则长等待会在清理阈值处被误删（见 decision-bridge.open 注释）
        timeoutMs,
    });

    const notification = {
        host: 'cursor',
        session_id: event.sessionId,
        notification_type: notificationType,
        // Cursor 没有可注入的终端；决策靠 decision_id 回流给正在阻塞的 hook 进程
        pts_device: null,
        decision_id: decisionId,
        created_at: Date.now(),
        responses,
        text_response: textResponse || null,
    };
    sessionState.addNotification(stateKey, notification);

    let messageId = null;
    try {
        messageId = await sendCard(app, buildCard(stateKey));
    } catch (err) {
        console.error('[cursor-hook] 发送卡片失败:', err.message);
        // 卡片没发出去 = 没人能作答，绝不能在这里阻塞
        sessionState.removeNotification(stateKey);
        decisionBridge.close(decisionId);
        return null;
    }

    const decision = await decisionBridge.wait(decisionId, { timeoutMs });

    decisionBridge.close(decisionId);
    try { sessionState.removeNotification(stateKey); } catch { /* 清理尽力而为 */ }

    // 收敛卡片：撤掉交互组件、把结果写在卡上，避免几小时后还能点、点了却「无人在等」。
    // 收敛只撤组件，不该把正文弄丢——具体怎么留由各调用方的 buildSettled 决定。
    const settled = decision
        ? describeDecision(responses, decision)
        : {
            // 超时的含义按链路不同：审批是交回本地弹窗，续写是本轮就地结束
            text: event.kind === 'followup'
                ? '⏳ **已超时** — 未收到回复，本轮就地结束'
                : '⏳ **已超时** — 已交回 Cursor 本地处理',
            template: 'grey',
        };
    try {
        const settledCard = buildSettled
            ? buildSettled(settled, decision)
            : cards.buildSettledCard({ event, statusText: settled.text, template: settled.template });
        await patchCard(app, messageId, settledCard);
    } catch (err) {
        console.error('[cursor-hook] 收敛卡片失败:', err.message);
    }

    return decision;
}

/** 裁决 → 收敛卡上的一行状态文案 */
function describeDecision(responses, decision) {
    // 被新一轮取代：要说清「这张卡不再等回复」，否则用户几小时后还会对着它打字
    if (decision?.superseded) {
        return { text: '↩️ **已被新一轮取代** — 这张卡不再等待回复', template: 'grey' };
    }
    const matched = Object.values(responses || {}).find(
        (entry) => JSON.stringify(entry.decision) === JSON.stringify(decision)
    );
    if (matched) {
        const template = decision.permission === 'deny' ? 'red'
            : decision.permission === 'allow' ? 'green' : 'grey';
        return { text: `${matched.label}`, template };
    }
    if (decision.followup_message) {
        return { text: `▶️ **已续写** — ${String(decision.followup_message).slice(0, 300)}`, template: 'green' };
    }
    if (decision.permission === 'deny') {
        return { text: `❌ **已拒绝** — ${String(decision.agent_message || '').slice(0, 300)}`, template: 'red' };
    }
    if (decision.permission === 'allow') return { text: '✅ **已允许**', template: 'green' };
    return { text: '✅ **已处理**', template: 'grey' };
}

// ── 各类事件处理 ──────────────────────────────────────────────────────────────

function steerMarkerPath(sessionKey) {
    return sharedTmpPath(`cursor-steer-${sessionKey}.json`);
}

/** 记下「这个会话刚打过引导」。写不进去要让调用方知道，否则会变成每个事件都复读 */
function markSteered(sessionKey) {
    try {
        fs.writeFileSync(steerMarkerPath(sessionKey), JSON.stringify({ ts: Date.now() }), 'utf8');
        return true;
    } catch { return false; }
}

/**
 * 会话【中途】要不要补打一次提问引导。
 *
 * sessionStart 那一针只在新建会话时打一次，长会话拿不到：实测重载窗口、乃至 Cursor
 * 自升级重启 server 都不会再触发 sessionStart（同一 conversation_id 上 12 次 stop、
 * 0 次 sessionStart），而且打过的那针也会被上下文压缩丢掉。这就是「跑了一天的会话
 * 又弹回 AskQuestion」的原因。
 *
 * 所以按会话 + 时间间隔在 postToolUse 上复读。间隔存在的意义是把 token 成本封顶：
 * 没有它就等于每个工具调用都复读一遍。
 */
function steerReminder(event, config) {
    if (!config.steerQuestions) return '';
    try {
        const { ts } = JSON.parse(fs.readFileSync(steerMarkerPath(event.sessionKey), 'utf8'));
        if (Number.isFinite(ts) && Date.now() - ts < config.steerRearmMs) return '';
    } catch { /* 没有标记 = 这个会话还没打过，照常打 */ }
    return markSteered(event.sessionKey) ? QUESTION_STEER_REMINDER : '';
}

/**
 * 会话开始：把「提问形态」约定注入初始系统上下文。
 *
 * 选择题本身不触发任何 hook、也不结束本轮，事后无从补救；只能在会话开头就把它引导成
 * 「调 ask_user 或正文列选项 + 结束本轮」，让问题落到我们掌控的链路上（详见
 * control-policy 里的说明）。这一针只对新建会话有效，已开着的会话靠 steerReminder 补。
 */
function handleSessionStart(event, config) {
    if (!config.steerQuestions) return {};
    // 后台 agent 背后没有人盯着 IDE，不存在「卡在选择题上等人点」的问题
    if (event.meta.isBackgroundAgent) return {};
    markSteered(event.sessionKey);
    return { additional_context: QUESTION_STEER_CONTEXT };
}

async function handleApproval(event, config) {
    if (!shouldAskApproval(config, event)) return {};

    const app = await getFeishuApp();
    if (!app) return {};

    const timeoutMs = config.approval.timeoutMs;
    const responses = cards.approvalResponses();
    const decision = await askFeishu({
        event,
        app,
        timeoutMs,
        responses,
        // 输入框里打的字 = 拒绝并把理由带给 agent
        textResponse: { field: 'agent_message', extra: { permission: 'deny' } },
        notificationType: `cursor_${event.meta.subject}_approval`,
        buildCard: (stateKey) => cards.buildApprovalCard({ event, stateKey, timeoutMs }),
    });

    return decision || timeoutDecision(event);
}

async function handleFollowup(event, config) {
    const waiting = shouldWaitFollowup(config, event);
    if (!waiting && !config.notifyStop) return {};

    const body = event.meta.isSubagent
        ? event.message
        : (consumeLastResponse(event.sessionKey) || event.message);

    if (!waiting) {
        // 纯通知：不放交互组件，交给 detached 子进程发，不让 Cursor 为一次网络往返干等
        sendCardDetached(cards.buildFollowupCard({
            event, stateKey: null, body, timeoutMs: 0, waiting: false,
        }));
        return {};
    }

    const app = await getFeishuApp();
    if (!app) return {};

    const timeoutMs = config.followup.timeoutMs;
    const decision = await askFeishu({
        event,
        app,
        timeoutMs,
        responses: cards.followupResponses(),
        textResponse: { field: 'followup_message' },
        notificationType: event.meta.isSubagent ? 'cursor_subagent_followup' : 'cursor_stop_followup',
        buildCard: (stateKey) => cards.buildFollowupCard({
            event, stateKey, body, timeoutMs, waiting: true,
        }),
        // 收敛时保留助手正文、沿用任务本身的配色：任务成功就该一直是绿的，
        // 不能因为「你回了一句话」或「点了结束本轮」就刷成一张灰色空卡
        buildSettled: (settled) => cards.buildSettledFollowupCard({
            event, body, statusText: settled.text,
        }),
    });

    return decision || {};
}

/** 实时摘要条目的公共字段。generationId 是轮次边界，cursor-live 靠它决定 patch 还是新发 */
function liveEnvelope(event) {
    return {
        generationId: event.meta.generationId,
        model: event.meta.model,
        projectName: event.meta.projectName,
        ts: Date.now(),
    };
}

function handleResponse(event, config) {
    recordLastResponse(event.sessionKey, event.message);
    if (config.liveCapture?.output && event.message) {
        appendLive(event.sessionKey, { type: 'text', text: event.message, ...liveEnvelope(event) });
    }
    return {};
}

function handleLive(event, config) {
    // 引导要先算，且不能受实时摘要开关影响：关掉 FEISHU_LIVE_CAPTURE 的人一样需要
    // 「选择题能远程作答」，这是两件不相干的事
    const reminder = steerReminder(event, config);

    const capture = config.liveCapture;
    // 用户主动中断不是故障，别在摘要里给它挂个 ❌
    const interrupted = event.meta.failed && event.meta.isInterrupt;
    if (!interrupted && capture && (capture.tools || capture.results)) {
        appendLive(event.sessionKey, {
            type: 'tool',
            tool: event.meta.toolName,
            icon: event.meta.icon,
            input: event.meta.inputSummary,
            result: capture.results ? event.meta.output : '',
            durationMs: event.meta.durationMs,
            // 失败不再单独发一张红卡，而是并进本轮同一张摘要卡里的一步
            ...(event.meta.failed ? { failed: true, failureReason: event.meta.failureReason } : {}),
            ...liveEnvelope(event),
        });
    }

    return reminder ? { additional_context: reminder } : {};
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const HANDLERS = {
    session: handleSessionStart,
    approval: handleApproval,
    followup: handleFollowup,
    response: handleResponse,
    live: handleLive,
};

/**
 * 维护「疑似卡在 IDE 交互上」的心跳。
 *
 * 每个事件都刷心跳并确保有看门狗在跑（ensureWatcher 见到活着的锁就是个空操作，
 * 代价只有一次文件读）。不能只在某一类事件上武装：卡在选择题的那轮永远不会结束，
 * 想等一个「特征事件」再武装，就永远等不到（判据详见 cursor-stall-watch 文件头）。
 */
function trackActivity(event, config) {
    if (!config.stall?.enabled) return;
    try {
        // 本轮已收尾：清掉心跳，看门狗自然退出，绝不能在 stop 之后还报「疑似在等你」
        if (event.meta.eventName === 'stop') {
            stallWatch.clearActivity(event.sessionKey);
            return;
        }
        stallWatch.recordActivity(event);
        stallWatch.ensureWatcher(event.sessionKey, config.stall.idleMs);
    } catch (err) {
        console.error('[cursor-hook] 心跳记录失败:', err.message);
    }
}

async function main() {
    protectStdout();
    require('../lib/env-config');

    const payload = await readStdin();
    if (!payload.hook_event_name) return emit({});

    const config = parseCursorControlConfig();
    if (!config.enabled) return emit({});

    const event = translateCursorHook(payload);

    // 必须在 handler 分流【之前】刷心跳：afterAgentThought 这类事件本仓库不处理
    // （kind=ignore），但它恰恰是「agent 还在思考」的唯一证据，漏掉就会误报卡死
    trackActivity(event, config);

    const handler = HANDLERS[event.kind];
    if (!handler) return emit({});

    // liveCapture 与 Claude/Codex 共用 FEISHU_LIVE_CAPTURE 语义
    config.liveCapture = require('./cursor-live').parseCaptureConfig();

    const decision = await handler(event, config);
    emit(renderHookOutput(event.meta.eventName, decision));
}

/** 兜底：出错也必须给 Cursor 一个合法 JSON。空对象 = 不干预，让它照常走 */
function run() {
    return main().catch((err) => {
        console.error('[cursor-hook] 未预期错误:', err.message);
        emit({});
    });
}

if (require.main === module) run();

module.exports = {
    main,
    run,
    getFeishuApp,
    sendCardDetached,
    askFeishu,
    describeDecision,
    supersedePrevious,
    trackActivity,
    handleSessionStart,
    handleApproval,
    handleFollowup,
    handleResponse,
    handleLive,
    steerReminder,
    steerMarkerPath,
    markSteered,
    liveBufferPath,
    lastResponsePath,
    recordLastResponse,
    consumeLastResponse,
    HANDLERS,
};
