'use strict';

/**
 * Cursor 飞书卡片构建。
 *
 * 与 Claude/Codex 卡片的关键差异：Cursor 没有可注入的终端，远程输入的唯一入口是
 * stop hook 的 followup_message。所以：
 *   - 审批卡 / 完成卡有交互组件（它们背后有个正在阻塞等待的 hook 进程）
 *   - 实时摘要卡【故意不带输入框】——运行中的 Cursor 收不到外部文字，
 *     摆一个点了没反应的输入框只会骗人
 *
 * 每张卡的 footer 都带 🤖 Cursor + 🧠 模型（rule §3：卡片必须能区分宿主）。
 */

const { card2, buttonRow, inputEl } = require('../lib/card');
const { buildCardFooter } = require('../lib/card-footer');
const { parseMarkdownToElements } = require('../lib/feishu-card-utils');

// 飞书单个 markdown 元素过长会被截断，分块阈值与 codex-live 保持一致
const TEXT_CHUNK = 1800;
const BODY_MAX = 6000;

const STATUS_STYLE = {
    completed: { template: 'green', title: 'Cursor 完成', icon: 'yes_outlined' },
    error: { template: 'red', title: 'Cursor 异常结束', icon: 'warning_outlined' },
    aborted: { template: 'grey', title: 'Cursor 已中断', icon: '' },
};

/**
 * footer：所有 Cursor 卡片共用，host/model 恒在，其余按有无渲染。
 *
 * machine 取自 AGENT_NOTIFIER_MACHINE：Cursor Remote-SSH 的 hook 是跑在【远程机】上的
 * （agent 运行时整个在那边），同一个飞书群会同时收到本机和好几台远程机的卡片。
 * 不标机器名的话，看到一张「Cursor 完成」根本不知道该去哪台机器上看。
 */
function cursorFooter({ model, projectName, duration = null, tokens = null } = {}) {
    return buildCardFooter({
        host: 'cursor',
        machine: process.env.AGENT_NOTIFIER_MACHINE || null,
        model,
        projectName,
        duration,
        tokens,
    });
}

function footerFor(event, extra = {}) {
    return cursorFooter({
        model: event?.meta?.model,
        projectName: event?.meta?.projectName,
        ...extra,
    });
}

/** 长文本切块，避免飞书截断（rule §6：长文本必须分块） */
function splitText(text, size = TEXT_CHUNK) {
    const raw = String(text == null ? '' : text);
    if (raw.length <= size) return raw ? [raw] : [];
    const chunks = [];
    for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size));
    return chunks;
}

function markdownBlocks(text) {
    return splitText(text).map((chunk) => ({ tag: 'markdown', content: chunk }));
}

/** 正文超长时只留最新一段：越靠后的内容越是用户此刻要看的 */
function clipBody(text) {
    const raw = String(text == null ? '' : text).trim();
    if (raw.length <= BODY_MAX) return raw;
    return '…（仅显示最新部分）\n\n' + raw.slice(-BODY_MAX);
}

/** 人类可读时长：窗口拉到 12/24 小时后，「43200s」这种写法没人能一眼读懂 */
function humanWindow(ms) {
    const sec = Math.round((ms || 0) / 1000);
    if (sec < 120) return `${sec} 秒`;
    if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
    const h = Math.round(sec / 360) / 10;
    return `${h} 小时`;
}

/** 等待提示：把「等多久、超时后会怎样」写在卡上，避免用户以为点了没用 */
function waitHint(timeoutMs, fallbackText) {
    return {
        tag: 'markdown',
        content: `<font color='grey'>⏳ 等待飞书回应，${humanWindow(timeoutMs)}内无人操作则${fallbackText}</font>`,
    };
}

// ── 审批卡（beforeShellExecution / beforeMCPExecution / preToolUse）──────────

const APPROVAL_RESPONSES = Object.freeze({
    allow: {
        label: '✅ 已允许',
        decision: { permission: 'allow' },
    },
    deny: {
        label: '❌ 已拒绝',
        decision: {
            permission: 'deny',
            user_message: '已在飞书上拒绝该操作',
            agent_message: '用户在飞书上拒绝了这次操作，请不要重试，改用其他方式或先询问用户。',
        },
    },
    local: {
        label: '🖥 交回本地确认',
        decision: { permission: 'ask', user_message: '已交回 Cursor 本地确认' },
    },
});

/**
 * 审批卡。按钮/输入框的回调最终由 feishu-listener 写进 decision-bridge，
 * 正阻塞着的 hook 进程读到后原样回给 Cursor。
 */
function buildApprovalCard({ event, stateKey, timeoutMs }) {
    const elements = [
        ...parseMarkdownToElements(event.message || '需要你的确认'),
        buttonRow([
            { text: '✅ 允许', actionType: 'allow', type: 'primary' },
            { text: '❌ 拒绝', actionType: 'deny', type: 'danger' },
            { text: '🖥 本地确认', actionType: 'local', type: 'default' },
        ], stateKey),
        inputEl(stateKey, '拒绝并说明原因（可选）…'),
        waitHint(timeoutMs, '回落到 Cursor 本地弹窗'),
        footerFor(event),
    ];

    return card2({
        template: 'orange',
        title: `${event.title} · Cursor`,
        elements,
    });
}

/** 审批卡的回调映射，连同卡片一起写进 sessionState */
function approvalResponses() {
    return JSON.parse(JSON.stringify(APPROVAL_RESPONSES));
}

// ── 完成卡 / 续写卡（stop / subagentStop）────────────────────────────────────

const FOLLOWUP_RESPONSES = Object.freeze({
    stop_now: {
        label: '⏹ 已结束本轮',
        // 空裁决 = 不给 followup_message，Cursor 就地收尾
        decision: {},
    },
});

/**
 * 完成卡。waiting=true 时挂上输入框——此时有个 stop hook 正阻塞着，
 * 用户在飞书里打的字会变成 followup_message，让 Cursor 自动继续下一轮。
 * waiting=false 时是纯通知卡，不放输入框（没人在等，点了也没用）。
 */
function buildFollowupCard({ event, stateKey, body, timeoutMs, waiting }) {
    const status = event.meta?.status || 'completed';
    const style = STATUS_STYLE[status] || STATUS_STYLE.completed;
    const shown = clipBody(body || event.message);

    const elements = [];
    if (shown) elements.push(...parseMarkdownToElements(shown));
    else elements.push({ tag: 'markdown', content: '任务已结束' });

    if (waiting) {
        elements.push(inputEl(stateKey, '继续对话：输入下一步指令…'));
        elements.push(buttonRow([
            { text: '⏹ 结束本轮', actionType: 'stop_now', type: 'default' },
        ], stateKey));
        elements.push(waitHint(timeoutMs, '本轮就地结束'));
    }

    elements.push(footerFor(event, {
        duration: event.meta?.durationMs ? `${Math.round(event.meta.durationMs / 1000)}s` : null,
    }));

    const title = event.meta?.isSubagent
        ? `${event.title}`
        : style.title;

    return card2({
        template: style.template,
        icon: style.icon || undefined,
        title,
        tags: waiting ? [{ text: '等待续写', color: 'orange' }] : [],
        elements,
    });
}

function followupResponses() {
    return JSON.parse(JSON.stringify(FOLLOWUP_RESPONSES));
}

// ── CLI 会话卡（飞书发起的会话，可随时回话）──────────────────────────────────

const CLI_STATUS_STYLE = {
    ready: { template: 'indigo', tag: { text: '就绪', color: 'indigo' }, icon: '' },
    running: { template: 'blue', tag: { text: '执行中', color: 'blue' }, icon: 'code_outlined' },
    done: { template: 'green', tag: { text: '已完成', color: 'green' }, icon: 'yes_outlined' },
    error: { template: 'red', tag: { text: '出错', color: 'red' }, icon: 'warning_outlined' },
};

/** CLI 的 usage 字段名与 card-footer 的期望不同，这里显式映射 */
function cliTokens(usage) {
    if (!usage) return null;
    return {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cached: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
    };
}

/**
 * 一轮一张卡：执行中不断 patch，结束时定稿。
 *
 * 与 hooks 那套实时摘要卡最大的不同：**输入框全程保留**。
 * 这类会话由本仓库通过 cursor-agent 拥有，任何时候都能把消息推进去（执行中的消息会排队），
 * 所以输入框不是摆设 —— 这正是 hooks 方案做不到的那件事。
 */
function buildCliTurnCard({
    segments = [],
    status = 'running',
    stateKey,
    projectName,
    model,
    usage = null,
    durationMs = null,
    queued = 0,
    capture = { tools: true, output: true, results: true },
}) {
    const style = CLI_STATUS_STYLE[status] || CLI_STATUS_STYLE.running;
    const elements = [];
    let steps = 0;

    segments.forEach((seg, idx) => {
        if (idx > 0) elements.push({ tag: 'hr' });
        if (capture.output && seg.text) {
            elements.push({
                tag: 'collapsible_panel',
                expanded: seg.text.length < 400,
                header: { title: { tag: 'plain_text', content: '❯ Cursor' } },
                elements: markdownBlocks(seg.text),
            });
        }
        (seg.tools || []).forEach((step) => {
            elements.push(buildToolPanel(step, capture));
            steps++;
        });
    });

    if (!elements.length) {
        const empty = {
            ready: '会话已就绪。在下方输入第一条指令，之后任何时候都能继续回话。',
            running: '正在启动…',
        }[status] || '（本轮无输出）';
        elements.push({ tag: 'markdown', content: empty });
    }

    if (queued > 0) {
        elements.push({
            tag: 'markdown',
            content: `<font color='orange'>⏳ 已排队 ${queued} 条指令，本轮结束后自动发出</font>`,
        });
    }

    if (stateKey) {
        elements.push(inputEl(stateKey, {
            running: '排队下一条指令…（本轮结束后自动发出）',
            ready: '输入第一条指令…',
        }[status] || '继续对话：输入下一步指令…'));
    }

    elements.push(cursorFooter({
        model,
        projectName,
        duration: durationMs ? `${Math.round(durationMs / 1000)}s` : null,
        tokens: cliTokens(usage),
    }));

    const tags = [style.tag];
    if (steps) tags.push({ text: `${steps} 步`, color: 'grey' });

    return card2({
        template: style.template,
        icon: style.icon,
        title: projectName ? `Cursor · ${projectName}` : 'Cursor 会话',
        tags,
        elements,
    });
}

/** 项目选择菜单：飞书发 `cursor` 后弹出 */
function buildCliLaunchMenu({ projects = [], stateKey, rootDir }) {
    const elements = [{
        tag: 'markdown',
        content: projects.length
            ? '选择要启动 Cursor 会话的项目，或在下方直接输入绝对路径：'
            : `${rootDir || '项目目录'} 下没找到项目，可直接输入绝对路径：`,
    }];

    projects.forEach((name, i) => elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: name },
        type: i === 0 ? 'primary' : 'default',
        value: { action_type: `opt_${i}`, session_state_key: stateKey },
    }));

    elements.push(inputEl(stateKey, '或输入绝对路径，回车启动…', 'cursor_path', 'cursor_launch_path'));
    elements.push(cursorFooter({ projectName: null }));

    return card2({ template: 'indigo', icon: '', title: '启动 Cursor 会话', elements });
}

// ── 收敛卡：交互卡有了结果/超时后 patch 成它 ─────────────────────────────────

/**
 * 把交互卡收敛成只读态（rule §3：交互卡要靠超时、提交、取消来收敛）。
 * 不这么做的话，审批卡会永远挂着可点的按钮，几小时后再点只会得到
 * 「无人在等」——把「已经结束了」直接写在卡上诚实得多。
 *
 * 注意收敛只该撤掉交互组件，**不该把正文也一起弄丢**：审批卡的 event.message 就是
 * 「即将执行什么」，那是这张卡事后唯一的查阅价值。
 */
function buildSettledCard({ event, statusText, template = 'grey' }) {
    return card2({
        template,
        icon: '',
        title: `${event.title} · 已处理`,
        elements: [
            { tag: 'markdown', content: statusText },
            { tag: 'hr' },
            ...parseMarkdownToElements(event.message || ''),
            footerFor(event),
        ],
    });
}

/**
 * 完成/续写卡的收敛版：**保留助手正文，沿用原本的状态配色**。
 *
 * 不能复用 buildSettledCard —— 它重渲染的是 event.message，而对 stop 事件那只是
 * 「任务已完成」五个字；真正的助手输出是单独传进来的 body。早期版本就是这样把正文
 * 弄丢、还顺手把卡刷成灰色的：任务明明成功了，回一句话之后卡片反而变成一张灰色空卡。
 *
 * 现在的行为：顶部一行回执（你回了什么 / 结束了 / 超时了），下面照旧是完整正文，
 * 配色仍由任务本身的成败决定（成功就该一直是绿的）。
 */
function buildSettledFollowupCard({ event, body, statusText }) {
    const status = event.meta?.status || 'completed';
    const style = STATUS_STYLE[status] || STATUS_STYLE.completed;
    const shown = clipBody(body || event.message);

    const elements = [];
    if (statusText) elements.push({ tag: 'markdown', content: statusText });
    if (shown) {
        if (statusText) elements.push({ tag: 'hr' });
        elements.push(...parseMarkdownToElements(shown));
    }
    elements.push(footerFor(event, {
        duration: event.meta?.durationMs ? `${Math.round(event.meta.durationMs / 1000)}s` : null,
    }));

    return card2({
        template: style.template,
        icon: style.icon || undefined,
        title: event.meta?.isSubagent ? event.title : style.title,
        elements,
    });
}

// ── 提问卡（MCP 工具 ask_user 发，见 cursor-ask-mcp）──────────────────────────

const ASK_CANCEL = Object.freeze({
    label: '⛔ 已取消提问',
    decision: { cancelled: true },
});

/**
 * 提问卡：让 agent 把「需要用户决策」这件事变成一次可远程作答的交互。
 *
 * 为什么不能用 IDE 自带的选择题组件：它不触发任何 hook、也不结束本轮，人在外面既看不到
 * 问题也无法回答（详见 docs/ai_rules.md 的实测结论）。而 MCP 工具调用有正常的返回值，
 * 我们可以在自己的进程里阻塞着等飞书那边点一下，再把答案作为工具结果交回 agent。
 *
 * 按钮/输入框的 action_type 沿用 Claude 选择卡那一套（opt_N / text_input / interrupt），
 * 于是 listener 的既有回流通路一行都不用改。
 */
function buildAskCard({ question, options = [], context = '', stateKey, timeoutMs, projectName, model }) {
    const elements = [];

    if (context) {
        elements.push(...parseMarkdownToElements(clipBody(context)));
        elements.push({ tag: 'hr' });
    }
    elements.push(...parseMarkdownToElements(clipBody(question) || '需要你做个决定'));

    options.forEach((opt, i) => {
        elements.push({
            tag: 'button',
            text: { tag: 'plain_text', content: String(opt).slice(0, 100) },
            type: i === 0 ? 'primary' : 'default',
            value: { action_type: `opt_${i}`, session_state_key: stateKey },
        });
    });

    elements.push(inputEl(stateKey, options.length ? '或直接输入你的答案…' : '输入你的答案…'));
    elements.push(buttonRow([
        { text: '⛔ 取消提问', actionType: 'interrupt', type: 'default' },
    ], stateKey));
    elements.push(waitHint(timeoutMs, '让它改用「正文列选项 + 结束本轮」，你仍可从完成卡回复'));
    elements.push(cursorFooter({ model, projectName }));

    return card2({
        template: 'turquoise',
        title: 'Cursor 需要你决定',
        tags: [{ text: '待你回答', color: 'turquoise' }],
        elements,
    });
}

/**
 * 提问卡的收敛版：撤掉按钮与输入框，把「问了什么、得到什么」留在卡上。
 * 保留问题正文——那是这张卡事后唯一的查阅价值；配色按有没有拿到答案区分。
 */
function buildSettledAskCard({ question, statusText, answered }) {
    const elements = [{ tag: 'markdown', content: statusText }];
    const shown = clipBody(question);
    if (shown) {
        elements.push({ tag: 'hr' });
        elements.push(...parseMarkdownToElements(shown));
    }
    return card2({
        template: answered ? 'green' : 'grey',
        icon: '',
        title: answered ? 'Cursor 提问 · 已回答' : 'Cursor 提问 · 已超时',
        elements,
    });
}

/** 提问卡的回调映射：opt_N → 该选项文本；输入框 → 自定义答案；中断 → 取消 */
function askResponses(options = []) {
    const responses = { interrupt: JSON.parse(JSON.stringify(ASK_CANCEL)) };
    options.forEach((opt, i) => {
        const label = String(opt);
        responses[`opt_${i}`] = { label: `已选择：${label}`, decision: { answer: label } };
    });
    return responses;
}

// ── 卡死告警卡（看门狗发，见 cursor-stall-watch）──────────────────────────────

/**
 * 「疑似卡在 IDE 交互上」告警卡。
 *
 * 刻意【不带任何交互组件】：这张卡是在「没有任何 hook 在等待」的状态下发出的，
 * 摆一个输入框只会骗人——用户打了字没有任何进程能接。它的唯一职责是把人叫回 IDE，
 * 所以正文要把「为什么飞书这边帮不上」说清楚，而不是含糊地说一句「似乎卡住了」。
 */
function buildStallCard({ body, idleMs, projectName, model }) {
    const min = Math.max(1, Math.round((idleMs || 0) / 60000));
    const elements = [{
        tag: 'markdown',
        content: `⚠️ **本轮既没有结束，也没有新动作** —— 已静止 ${min} 分钟。\n\n`
            + '最可能是 Cursor 停在 IDE 里的**交互式选择题/确认框**上等你点击。'
            + '那类交互不触发任何 hook，飞书这边既看不到问题、也没法替你作答，'
            + '需要你回到 IDE 里点一下。',
    }];

    const shown = clipBody(body);
    if (shown) {
        elements.push({ tag: 'hr' });
        elements.push({ tag: 'markdown', content: '**它最后说的话**' });
        elements.push(...parseMarkdownToElements(shown));
    }

    elements.push(cursorFooter({ model, projectName }));

    return card2({
        template: 'yellow',
        icon: 'warning_outlined',
        title: 'Cursor 疑似在等你确认',
        tags: [{ text: '需回 IDE', color: 'yellow' }],
        elements,
    });
}

// ── 实时执行摘要卡（postToolUse + afterAgentResponse 聚合）───────────────────

/** 命令/路径的单行预览：折叠面板标题只放一行，防止飞书里多行相互重叠 */
function toolPreview(step) {
    const first = String(step.input || '').split('\n')[0];
    return first.length > 56 ? first.slice(0, 56) + '…' : first;
}

/**
 * 单个工具 → 默认折叠面板：标题是图标+工具+命令首行，展开才看完整命令与结果。
 * 失败的那一步换成 ❌ 并默认展开——它不再有独立的失败卡，全靠这里被看见。
 */
function buildToolPanel(step, capture) {
    const preview = capture.tools ? toolPreview(step) : '';
    const icon = step.failed ? '❌' : (step.icon || '🔧');
    const label = step.failed ? `${step.tool} — ${step.failureReason || '执行失败'}` : step.tool;
    const title = `${icon} ${label}` + (preview ? `  ${preview}` : '');
    const body = [];
    if (capture.tools && step.input) {
        body.push(step.tool === 'Shell'
            ? { tag: 'markdown', content: '```bash\n' + step.input + '\n```' }
            : { tag: 'markdown', content: '`' + step.input + '`' });
    }
    if (capture.results && step.result) {
        const result = String(step.result).trim();
        const clipped = result.length > TEXT_CHUNK ? result.slice(0, TEXT_CHUNK) + '\n…（已截断）' : result;
        const heading = step.failed ? '**报错**' : '**结果**';
        body.push({ tag: 'markdown', content: heading + '\n```\n' + clipped + '\n```' });
    }
    if (!body.length) body.push({ tag: 'markdown', content: '_（无更多详情）_' });
    return {
        tag: 'collapsible_panel',
        expanded: !!step.failed,
        header: { title: { tag: 'plain_text', content: title } },
        elements: body,
    };
}

/**
 * 一轮一张卡：本轮所有「助手文字段 + 其后的工具」合并进同一张（与 claude-live 同款形态）。
 * 刻意不带输入框：Cursor 运行中没有可回流的输入通道。
 */
function buildLiveCard({ segments, capture, model, projectName }) {
    const elements = [];
    let steps = 0;
    let failed = 0;

    segments.forEach((seg, idx) => {
        if (idx > 0) elements.push({ tag: 'hr' });
        if (capture.output && seg.text) {
            elements.push({
                tag: 'collapsible_panel',
                expanded: seg.text.length < 200,
                header: { title: { tag: 'plain_text', content: '❯ Cursor' } },
                elements: markdownBlocks(seg.text),
            });
        }
        (seg.tools || []).forEach((step) => {
            elements.push(buildToolPanel(step, capture));
            steps++;
            if (step.failed) failed++;
        });
    });

    elements.push(cursorFooter({ model, projectName }));

    // 失败在 header 上留个红标签：折叠面板再怎么展开，也得先让人知道这轮有东西挂了
    const tags = [{ text: `${steps} 步`, color: 'indigo' }];
    if (failed) tags.push({ text: `${failed} 步失败`, color: 'red' });

    return card2({
        template: 'indigo',
        title: '执行摘要',
        tags,
        elements,
    });
}

module.exports = {
    humanWindow,
    buildApprovalCard,
    buildFollowupCard,
    buildAskCard,
    buildSettledAskCard,
    askResponses,
    buildStallCard,
    buildLiveCard,
    buildSettledCard,
    buildSettledFollowupCard,
    buildCliTurnCard,
    buildCliLaunchMenu,
    buildToolPanel,
    cliTokens,
    approvalResponses,
    followupResponses,
    cursorFooter,
    splitText,
    clipBody,
    APPROVAL_RESPONSES,
    FOLLOWUP_RESPONSES,
};
