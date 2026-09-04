/**
 * Cursor「疑似卡在 IDE 交互上」看门狗。
 *
 * 为什么需要它：IDE 里的交互式选择题（AskQuestion）是【零 hook 事件】的死角——
 * 实测 preToolUse / postToolUse 都不触发，官方事件全表里也没有任何一个对应
 * 「agent 正在等用户回答」。而且它不结束本轮，所以 stop 不触发、完成卡不会发：
 * 人在外面完全看不到会话已经停在那儿等人点了。
 *
 * 既然没有任何「正向事件」可用，唯一能观测的信号就是【沉默】。但沉默本身不足以判定：
 * 一条十分钟的编译命令同样是十分钟沉默。所以判据要再加一条——
 *
 *   最后一个事件不能是「有活儿正在进行中」的那种。
 *
 * `beforeShellExecution` / `beforeMCPExecution` / `subagentStart` 都是「开始干某件事」，
 * 它们之后的沉默是正常的（活儿干完自然会有 postToolUse）。而 `postToolUse` 之后的沉默
 * 意味着上一件事已经收尾、agent 却既没开始下一件也没结束本轮 —— 那才可疑。
 *
 * 别把判据写成「最后事件必须是 afterAgentResponse」：实测 afterAgentResponse 只在
 * 【一轮结束时】触发（一轮里几十条助手消息都不会触发它），而卡在选择题的那轮永远
 * 不会结束，所以那样写等于永远不告警。
 *
 * 残留误报（实测踩过，别把阈值再调小）：agent 组织一段长回复、或做一次大上下文的思考，
 * 期间【什么事件都不产生】—— 文字要到轮末的 afterAgentResponse 才有信号。3 分钟阈值因此
 * 会在正常长回合里误报。默认阈值已放到 15 分钟：这个兜底的价值本来就随 ask_user
 * （MCP 提问工具）的落地而大幅下降了，宁可漏报也不该在人干活时乱叫。
 *
 * 另一条抑制规则：该会话已经有一张待回复的卡在外面时不告警 —— 用户并不是两眼一抹黑。
 *
 * 报一次就退出：真被解开了会有新事件重新拉起看门狗，不会连环轰炸。
 */

'use strict';

const fs = require('fs');
const { sharedTmpPath } = require('../lib/tmp-dir');

// 轮询间隔：取 idle 的四分之一，但不低于 5s、不高于 30s。
// 看门狗睡着的时候不占 CPU，间隔小一点换来的是告警更贴近阈值。
const MIN_TICK_MS = 5 * 1000;
const MAX_TICK_MS = 30 * 1000;

// 看门狗自身的寿命上限：会话可能被直接关掉（心跳文件永远不再更新也不会被删），
// 不给上限就会留下一堆永不退出的进程。
const MAX_WATCH_MS = 6 * 60 * 60 * 1000;

/**
 * 「agent 刚干完一件事、理应马上有下一步」的事件——只有这些之后的沉默才算可疑。
 *
 * 写成允许清单而不是「排除在跑中的事件」，是因为后者会把两类正常状态误判成卡死：
 *   · beforeShellExecution / beforeMCPExecution / subagentStart —— 活儿正在跑，
 *     沉默是应该的（干完自然会有 postToolUse 刷心跳）
 *   · sessionStart —— 开了个新窗口却还没使唤它。实测就是这条把「开着不用的窗口」
 *     全变成了误报：3 分钟后每个空窗口都收一张「疑似在等你确认」。
 * 而且允许清单是安全的默认：以后为刷心跳再注册什么观测类事件，都不会自动变成告警源。
 *
 * 代价（已知且接受）：如果 agent 在一轮开头就直接弹选择题、期间既没思考事件也没工具调用，
 * 心跳会停在 sessionStart 或压根没有心跳，那种情况检测不到。宁可漏报不可乱报——
 * 这张卡本身能提供的信息很有限（见 docs/ai_rules.md）。
 */
const WORK_EVENTS = new Set([
    'postToolUse',
    'postToolUseFailure',
    'afterAgentThought',
    'afterAgentResponse',
]);

function activityPath(sessionKey) {
    return sharedTmpPath(`cursor-activity-${sessionKey}.json`);
}

function lockPath(sessionKey) {
    return sharedTmpPath(`cursor-stall-${sessionKey}.lock`);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 原子写：看门狗与 hook 是两个进程，读侧不能看到半截 JSON */
function writeAtomic(target, value) {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
        fs.renameSync(tmp, target);
    } catch { /* 心跳只是兜底能力，写不进去不该影响 hook 主流程 */ }
}

/**
 * 记一次心跳（hook 侧，每个事件都调）。
 * stopped=true 表示本轮已正常收尾，看门狗看到就直接退出，绝不再告警。
 */
function recordActivity(event, { stopped = false } = {}) {
    const meta = event.meta || {};
    writeAtomic(activityPath(event.sessionKey), {
        ts: Date.now(),
        event: meta.eventName || '',
        stopped: !!stopped,
        session_key: event.sessionKey,
        session_id: event.sessionId,
        project: meta.projectName || '',
        model: meta.model || '',
        conversation_name: meta.conversationName || '',
        workspace_root: meta.workspaceRoot || '',
    });
}

/** 会话正常收尾/结束：清掉心跳与锁，让看门狗尽快自然退出 */
function clearActivity(sessionKey) {
    for (const file of [activityPath(sessionKey), lockPath(sessionKey)]) {
        try { fs.unlinkSync(file); } catch { /* 不存在即已清理 */ }
    }
}

/**
 * 该会话是否已经有一张待回复的卡在外面（审批 / 续写 / MCP 提问都算）。
 * 有的话就别再告警：用户手上已经有可操作的东西，多一张「疑似卡住」只是噪音。
 */
function hasPendingCard(sessionId) {
    if (!sessionId) return false;
    try {
        const { decisionBridge } = require('../lib/decision-bridge');
        return decisionBridge.listPending({ sessionId }).length > 0;
    } catch {
        return false; // 查不了就当没有，宁可多报一次也不要静默失效
    }
}

function pidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0); // 信号 0 只探测存在性
        return true;
    } catch (err) {
        return err.code === 'EPERM'; // 进程在但不属于我们
    }
}

/**
 * 该不该告警。纯函数，便于测试。
 * 三个条件缺一不可：本轮没收尾、最后一个事件属于 WORK_EVENTS、沉默已超阈值。
 */
function shouldAlert(heartbeat, idleMs, now = Date.now()) {
    if (!heartbeat || !heartbeat.ts) return false;
    if (heartbeat.stopped) return false;
    if (!WORK_EVENTS.has(heartbeat.event)) return false;
    return now - heartbeat.ts >= idleMs;
}

/**
 * 确保该会话有一个看门狗在跑（hook 侧调用）。
 * 已有活着的看门狗就什么都不做——否则每个事件都 spawn 一个，几十个进程一起数同一个数。
 *
 * 抢锁必须是原子的：hook 是每个事件一个独立进程，同一瞬间可能有好几个并发调这里。
 * 「先读锁发现没有 → 再 spawn → 再写锁」中间有窗口，实测真的抢出过两个看门狗
 * （同一会话两个 pid），后果是重复告警。所以改成 open(..., 'wx') 独占创建：
 * 只有创建成功的那个进程才去 spawn。
 */
function ensureWatcher(sessionKey, idleMs) {
    const lock = lockPath(sessionKey);
    const existing = readJson(lock);
    if (existing && pidAlive(existing.pid)) return false;
    // 锁在但进程死了（看门狗被 kill，来不及删锁）→ 清掉再抢
    if (existing) { try { fs.unlinkSync(lock); } catch { /* 别人已清 */ } }

    let fd;
    try {
        fd = fs.openSync(lock, 'wx'); // 'wx' = 独占创建，已存在就抛
    } catch {
        return false; // 并发中的另一个进程抢到了，交给它
    }

    try {
        const child = require('child_process').spawn(
            process.execPath,
            [__filename, '--watch', sessionKey, '--idle', String(idleMs)],
            { detached: true, stdio: 'ignore', env: process.env }
        );
        child.unref();
        fs.writeSync(fd, JSON.stringify({ pid: child.pid, started_at: Date.now() }));
        return true;
    } catch (err) {
        console.error('[cursor-stall] 无法启动看门狗:', err.message);
        // spawn 失败就必须把锁还回去，否则这个会话再也武装不起来
        try { fs.unlinkSync(lock); } catch { /* 忽略 */ }
        return false;
    } finally {
        try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
}

/** 取那段「说完就没动静」的正文：它多半就是 agent 提的那个问题的上文 */
function peekLastResponse(sessionKey) {
    try {
        // 只读不删：这段正文还要留给随后可能到来的完成卡
        const { lastResponsePath } = require('./cursor-hook');
        const { text } = JSON.parse(fs.readFileSync(lastResponsePath(sessionKey), 'utf8'));
        return String(text || '').trim();
    } catch { return ''; }
}

async function sendStallCard(heartbeat, idleMs) {
    require('../lib/env-config');
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return false;

    // 走工厂而不是 new Lark.Client：出网强制走代理的机器上 SDK 传输层会静默挂住
    const { createLarkHttpClient } = require('../channels/feishu/feishu-client');
    const client = createLarkHttpClient({ appId, appSecret });
    const { resolveFeishuChatId } = require('../channels/feishu/resolve-chat-id');
    const chatId = await resolveFeishuChatId({
        preferredChatId: process.env.FEISHU_CHAT_ID,
        larkClient: client,
    });
    if (!chatId) return false;

    const { buildStallCard } = require('./cursor-cards');
    const card = buildStallCard({
        body: peekLastResponse(heartbeat.session_key),
        idleMs,
        projectName: heartbeat.project || '',
        model: heartbeat.model || '',
        conversationName: heartbeat.conversation_name || '',
    });

    try {
        await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        return true;
    } catch (err) {
        console.error('[cursor-stall] 发送失败:', err.message);
        return false;
    }
}

/** 看门狗主循环。告警一次即退出；心跳消失/已收尾/超寿命也退出。 */
async function watch(sessionKey, idleMs) {
    const tick = Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, Math.round(idleMs / 4)));
    const deadline = Date.now() + MAX_WATCH_MS;

    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, tick));

        const heartbeat = readJson(activityPath(sessionKey));
        // 心跳文件没了 = 会话收摊（stop 走了清理），或者从未建立
        if (!heartbeat) break;
        if (heartbeat.stopped) break;
        if (Date.now() > deadline) break;

        if (shouldAlert(heartbeat, idleMs)) {
            // 已经有卡在外面就继续等，不叠一张噪音卡；卡被回应后本轮自然会有新事件
            if (hasPendingCard(heartbeat.session_id)) continue;
            await sendStallCard(heartbeat, idleMs);
            break;
        }
    }

    // 只删自己那把锁：万一本进程退得晚、锁已经属于新的看门狗，删掉会让它被重复武装
    const lock = readJson(lockPath(sessionKey));
    if (!lock || lock.pid === process.pid) {
        try { fs.unlinkSync(lockPath(sessionKey)); } catch { /* 已被清理 */ }
    }
}

if (require.main === module) {
    const args = process.argv;
    if (args[2] === '--watch') {
        const sessionKey = args[3];
        const idleMs = parseInt(args[args.indexOf('--idle') + 1], 10) || 180000;
        watch(sessionKey, idleMs).catch((err) => {
            console.error('[cursor-stall] 看门狗错误:', err.message);
            process.exit(0);
        });
    }
}

module.exports = {
    recordActivity,
    clearActivity,
    ensureWatcher,
    shouldAlert,
    sendStallCard,
    watch,
    activityPath,
    lockPath,
    peekLastResponse,
    hasPendingCard,
    WORK_EVENTS,
    MAX_WATCH_MS,
};
