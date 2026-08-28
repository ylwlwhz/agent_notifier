'use strict';

/**
 * Cursor 远程控制策略：决定哪些 hook 事件真的去飞书「等人拍板」，等多久，
 * 以及等不到时怎么回落。
 *
 * 为什么审批/续写默认关闭：Cursor 的这些 hook 是【阻塞】的——hook 不返回，Cursor 就
 * 一直等，期间 IDE 里不会弹它自己的确认框。若默认开启，坐在电脑前的人会莫名卡住
 * （beforeShellExecution 对每条命令都触发，包括本来会被自动放行的 ls）。
 * 因此：通知类（完成 / 失败 / 实时摘要）开箱即用；控制类要显式在 .env 里打开。
 *
 * 超时一律回落到宿主本地行为，绝不把 Cursor 永久挂住：
 *   审批 → permission:'ask'（Cursor 自己弹窗问）
 *   续写 → {}（本轮正常结束）
 */

const DEFAULT_APPROVAL_TIMEOUT_SEC = 180;
const DEFAULT_FOLLOWUP_TIMEOUT_SEC = 300;
// 15 分钟而不是 3 分钟：agent 组织长回复或做大上下文思考时【什么事件都不产生】，
// 3 分钟会在正常长回合里误报（实测踩过）。而这个兜底的价值随 ask_user（MCP 提问工具）
// 落地已大幅下降，宁可漏报也不该在人干活时乱叫。
const DEFAULT_STALL_ALERT_SEC = 900;
// 引导复读间隔：sessionStart 那一针只打在会话开头，长会话里会被上下文压缩丢掉
// （实测：GY_2 上一个跑了 20 小时的会话又弹回了 AskQuestion）。所以在 postToolUse
// 上按会话补打，30 分钟一次——够新鲜，又不至于每轮都烧 token。
const DEFAULT_STEER_REARM_SEC = 1800;

/**
 * sessionStart 注入的提问形态约定。
 *
 * 为什么需要它：AskQuestion（IDE 里的交互式选择题）是【零 hook 事件】的——实测
 * preToolUse / postToolUse 都不触发，官方 18 个事件里也没有任何一个对应「agent 正在
 * 等用户回答」。更要命的是它不结束本轮，所以 stop 也不会触发、完成卡不会发：人在外面
 * 既看不到问题、也无法回答，会话就那么静止着。
 *
 * 唯一的解法是别让它走到那一步：把「选项」引导成正文 + 结束本轮，于是问题落在 stop
 * 卡上，用户在飞书输入框里回一句就成了 followup_message —— 那条链路我们完全掌控。
 */
const QUESTION_STEER_CONTEXT = [
    '[agent-notifier 远程控制约定]',
    '本会话接了飞书远程通知：用户经常不在电脑前，只能从手机上的飞书卡片操作。',
    '',
    '**不要使用 AskQuestion 这类 IDE 内置的交互式选择题组件。**',
    '它不触发任何 hook，也不结束本轮：用户在手机上看不到问题、更无法回答，会话会一直静止。',
    '',
    '需要用户做决定时，按这个顺序选：',
    '1. 如果有 MCP 工具 `ask_user`（服务名 agent-notifier-ask），就调它 —— 它会把问题连同',
    '   候选项发成飞书卡片并阻塞等待，用户点一下，答案就作为工具结果回到你手里。',
    '2. 没有该工具时，把问题和候选项【编上号写进正文】，然后结束本轮。本轮结束会推一张',
    '   带输入框的完成卡，用户回一个编号（比如「2」）就能继续。',
].join('\n');

/**
 * 同一条约定的精简版，走 postToolUse 的 `additional_context` 在会话【中途】补打。
 *
 * 为什么必须有第二个注入点：`sessionStart` 只在【新建会话】时触发一次——实测重载窗口、
 * 甚至 Cursor 自身升级重启 server 都不会再触发它（探针在同一个 conversation_id 上抓到
 * 12 次 stop、0 次 sessionStart）。于是「开着不关的长会话」永远拿不到这条约定，或者
 * 拿到过但被上下文压缩丢掉了，agent 就会退回默认行为去弹 AskQuestion。
 *
 * `postToolUse` 是官方文档里除 sessionStart 之外唯一支持 `additional_context` 的 agent
 * 事件（`beforeSubmitPrompt` 只有 continue/user_message，`afterAgentThought` 明确无输出
 * 字段）。实测注入的文本会以 `<system_reminder>` 的形式紧跟在工具结果之后进入上下文。
 *
 * 写得比 sessionStart 版短得多：它按间隔复读，长度直接乘在 token 成本上。
 */
const QUESTION_STEER_REMINDER = [
    '[agent-notifier] 用户可能不在电脑前，只能从手机飞书卡片操作本会话。',
    '需要用户在若干方案之间做决定时：优先调 MCP 工具 `ask_user`（服务名 agent-notifier-ask）；',
    '没有该工具就把候选项编上号写进正文并结束本轮。不要用 AskQuestion —— 它不触发任何',
    'hook 也不结束本轮，用户在手机上既看不到问题也无法回答，会话会一直静止。',
].join('\n');

function truthy(value, fallback = false) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return fallback;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return ['1', 'true', 'yes', 'on', 'all'].includes(raw) ? true : fallback;
}

function parseSeconds(value, fallbackSec) {
    const n = parseFloat(value);
    return (Number.isFinite(n) && n > 0 ? n : fallbackSec) * 1000;
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 编译用户给的匹配式；写错了就当「不过滤」，并把原因说清楚而不是静默全放行 */
function compileMatcher(pattern, label) {
    const raw = String(pattern || '').trim();
    if (!raw) return null;
    try {
        return new RegExp(raw);
    } catch (err) {
        console.error(`[cursor-hook] ${label} 正则无效（${err.message}），本次不做过滤`);
        return null;
    }
}

function parseCursorControlConfig(env = process.env) {
    const approvalEnabled = truthy(env.CURSOR_REMOTE_APPROVAL, false);
    return {
        enabled: truthy(env.CURSOR_NOTIFY_ENABLED, true),
        notifyFailure: truthy(env.CURSOR_NOTIFY_FAILURE, true),
        notifyStop: truthy(env.CURSOR_NOTIFY_STOP, true),
        // 默认开：不开的话「选择题」这类交互永远无法远程作答（见 QUESTION_STEER_CONTEXT）
        steerQuestions: truthy(env.CURSOR_STEER_QUESTIONS, true),
        // 同一会话里隔多久在 postToolUse 上补打一次引导（见 QUESTION_STEER_REMINDER）
        steerRearmMs: parseSeconds(env.CURSOR_STEER_REARM_SEC, DEFAULT_STEER_REARM_SEC),
        stall: {
            enabled: truthy(env.CURSOR_STALL_ALERT, true),
            idleMs: parseSeconds(env.CURSOR_STALL_ALERT_SEC, DEFAULT_STALL_ALERT_SEC),
        },
        approval: {
            enabled: approvalEnabled,
            timeoutMs: parseSeconds(env.CURSOR_APPROVAL_TIMEOUT_SEC, DEFAULT_APPROVAL_TIMEOUT_SEC),
            // 只对匹配的命令/服务要审批，其余放行——这是把「每条命令都问」降噪的主要手段
            shellMatcher: compileMatcher(env.CURSOR_APPROVAL_MATCHER, 'CURSOR_APPROVAL_MATCHER'),
            mcpMatcher: compileMatcher(env.CURSOR_APPROVAL_MCP_MATCHER, 'CURSOR_APPROVAL_MCP_MATCHER'),
            // preToolUse 对每个工具都触发，默认不接管；显式列出工具名才走飞书
            tools: new Set(parseList(env.CURSOR_APPROVE_TOOLS)),
        },
        followup: {
            enabled: truthy(env.CURSOR_REMOTE_FOLLOWUP, false),
            timeoutMs: parseSeconds(env.CURSOR_FOLLOWUP_TIMEOUT_SEC, DEFAULT_FOLLOWUP_TIMEOUT_SEC),
            subagent: truthy(env.CURSOR_REMOTE_FOLLOWUP_SUBAGENT, false),
            // 只有正常完成才值得续写；aborted/error 让它就地结束，避免把失败循环放大
            statuses: new Set(parseList(env.CURSOR_FOLLOWUP_STATUSES).length
                ? parseList(env.CURSOR_FOLLOWUP_STATUSES)
                : ['completed']),
        },
    };
}

/** 该审批事件是否要送到飞书等人拍板 */
function shouldAskApproval(config, event) {
    const { approval } = config;
    if (!approval.enabled) return false;
    const meta = event.meta || {};

    if (meta.subject === 'shell') {
        if (!approval.shellMatcher) return true;
        return approval.shellMatcher.test(String(meta.command || ''));
    }
    if (meta.subject === 'mcp') {
        if (!approval.mcpMatcher) return true;
        return approval.mcpMatcher.test(`${meta.mcpServer || ''}.${meta.toolName || ''}`);
    }
    // preToolUse：必须显式列名，否则每个工具调用都要人点一次
    return approval.tools.has(meta.toolName);
}

/** 该 stop/subagentStop 是否要等人给下一步指令 */
function shouldWaitFollowup(config, event) {
    const { followup } = config;
    if (!followup.enabled) return false;
    if (event.meta?.isSubagent && !followup.subagent) return false;
    return followup.statuses.has(event.meta?.status || 'completed');
}

/**
 * 超时回落。审批回 'ask' 让 Cursor 自己弹窗——但 preToolUse 的 'ask' 官方明确
 * 「schema 接受、当前不生效」，回它等于什么都没说，不如直接回空对象，语义更诚实。
 */
function timeoutDecision(event) {
    if (event.kind !== 'approval') return {};
    if (event.meta?.eventName === 'preToolUse') return {};
    return {
        permission: 'ask',
        user_message: '飞书审批超时，请在此确认',
    };
}

const ALLOWED_OUTPUT_FIELDS = {
    sessionStart: ['additional_context', 'env'],
    // 会话中途补打提问引导的唯一通道（见 QUESTION_STEER_REMINDER）。
    // 官方另有 updated_mcp_tool_output，本仓库不改工具结果，故不放行。
    postToolUse: ['additional_context'],
    beforeShellExecution: ['permission', 'user_message', 'agent_message'],
    beforeMCPExecution: ['permission', 'user_message', 'agent_message'],
    preToolUse: ['permission', 'user_message', 'agent_message', 'updated_input'],
    stop: ['followup_message'],
    subagentStop: ['followup_message'],
};

/**
 * 只输出该事件支持的字段（官方要求）。多余字段会让 Cursor 侧校验失败，
 * 进而按「hook 返回无效 JSON」处理——failClosed 时就变成直接拦下操作。
 */
function renderHookOutput(eventName, decision = {}) {
    const allowed = ALLOWED_OUTPUT_FIELDS[eventName];
    if (!allowed) return {};
    const out = {};
    for (const field of allowed) {
        const value = decision[field];
        if (value === undefined || value === null || value === '') continue;
        out[field] = value;
    }
    return out;
}

module.exports = {
    parseCursorControlConfig,
    shouldAskApproval,
    shouldWaitFollowup,
    timeoutDecision,
    renderHookOutput,
    ALLOWED_OUTPUT_FIELDS,
    QUESTION_STEER_CONTEXT,
    QUESTION_STEER_REMINDER,
};
