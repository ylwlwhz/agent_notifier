'use strict';

// schema 2.0 卡片构建公共件。交互组件的 value:{action_type,session_state_key} 结构与 1.0 一致，
// listener 回调路由不受影响；2.0 取消了 action 容器，按钮改用 column_set 横排、输入框直接入 body。

// 各主题色默认图标（飞书 standard_icon token）
const TEMPLATE_ICON = {
    green: 'yes_outlined',
    red: 'warning_outlined',
    orange: 'lock_outlined',
    blue: 'code_outlined',
};

/** schema 2.0 卡片信封：header(icon+title+subtitle+彩色标签) + body.elements */
function card2({ template, icon, title, subtitle, tags = [], elements }) {
    const header = { title: { tag: 'plain_text', content: title }, template };
    const tok = icon !== undefined ? icon : TEMPLATE_ICON[template];
    if (tok) header.icon = { tag: 'standard_icon', token: tok };
    if (subtitle) header.subtitle = { tag: 'plain_text', content: subtitle };
    const tagList = tags.filter(Boolean).map(t => ({ tag: 'text_tag', text: { tag: 'plain_text', content: t.text }, color: t.color || 'grey' }));
    if (tagList.length) header.text_tag_list = tagList;
    return { schema: '2.0', config: { wide_screen_mode: true }, header, body: { elements: elements.filter(Boolean) } };
}

// 限额档位 → 标签名。与 scripts/statusline.sh 的 limit_label 保持同一套叫法，
// 手机上看卡片和电脑上看状态栏说的是同一个东西。未知档位原样显示。
const LIMIT_LABEL = {
    five_hour: '5h',
    seven_day: '周',
    seven_day_overage_included: 'Fable',
    seven_day_opus: 'Opus',
    seven_day_sonnet: 'Sonnet',
    overage: '额度',
};

/** 快用完时才需要显眼：≥90 红、≥70 橙，其余灰——这是每张卡片都常驻的标签，平时别抢眼 */
function limitTagColor(pct) {
    return pct >= 90 ? 'red' : pct >= 70 ? 'orange' : 'grey';
}

/** stats（套餐限额 / 上下文，均来自 statusLine 官方字段）→ header 彩色标签 */
function statsTags(stats) {
    if (!stats) return [];
    const tags = [];
    // 本次会话花了多少钱、跑了多久，看到卡片时都已成定局，改变不了下一步动作；
    // 「5h 已用 82%」才会——所以这里放限额，不放 session 成本与总时长。
    for (const [key, v] of Object.entries(stats.rateLimits || {})) {
        if (!v || v.used_percentage == null) continue;
        const pct = Math.round(v.used_percentage);
        tags.push({ text: `${LIMIT_LABEL[key] || key} ${pct}%`, color: limitTagColor(pct) });
    }
    if (stats.contextPct != null) tags.push({ text: `🧠 ${stats.contextPct}%`, color: 'grey' });
    return tags;
}

/** 输入框（直接放 body.elements） */
function inputEl(stateKey, placeholder = '输入指令...', name = 'user_input', actionType = 'text_input') {
    return { tag: 'input', name, placeholder: { tag: 'plain_text', content: placeholder }, value: { action_type: actionType, session_state_key: stateKey } };
}

/** 中断按钮 */
function escButton(stateKey) {
    return { tag: 'button', text: { tag: 'plain_text', content: '⛔ 中断' }, type: 'danger', size: 'tiny', value: { action_type: 'interrupt', session_state_key: stateKey } };
}

/** 按钮横排：column_set，每按钮等宽一列。buttons: [{text, actionType, type}] */
function buttonRow(buttons, stateKey) {
    return {
        tag: 'column_set',
        horizontal_spacing: '8px',
        columns: buttons.map(b => ({
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: b.text }, type: b.type || 'default', width: 'fill', value: { action_type: b.actionType, session_state_key: stateKey } }],
        })),
    };
}

/** AskUserQuestion 选择卡：context + 问题 + 竖排选项按钮 + Other + 输入框 + ESC + footer。
 *  mdToEls = parseMarkdownToElements（由调用方传入，避免 card.js ↔ feishu-card-utils 循环依赖） */
function selectCard({ template = 'orange', title, tags, contextText, question, options, stateKey, noteParts, mdToEls }) {
    const els = [];
    if (contextText) { els.push(...mdToEls(contextText)); els.push({ tag: 'hr' }); }
    if (question) els.push(...mdToEls(question));
    // 选项支持字符串或 {label, description}：按钮显示 label，按钮下灰字补 description。
    // description 只是展示行，不新增按钮，opt_N → 第 N 个选项的箭头导航映射不受影响。
    options.forEach((opt, i) => {
        const label = typeof opt === 'string' ? opt : (opt && opt.label) || '';
        const desc = typeof opt === 'string' ? '' : (opt && opt.description) || '';
        els.push({ tag: 'button', text: { tag: 'plain_text', content: label }, type: i === 0 ? 'primary' : 'default', value: { action_type: `opt_${i}`, session_state_key: stateKey } });
        if (desc) els.push({ tag: 'markdown', content: `<font color='grey'>${desc}</font>` });
    });
    els.push({ tag: 'button', text: { tag: 'plain_text', content: '💬 Other' }, type: 'default', value: { action_type: 'opt_other', session_state_key: stateKey } });
    els.push(inputEl(stateKey, '输入自定义回答...'));
    els.push(escButton(stateKey));
    if (noteParts) els.push({ tag: 'markdown', content: noteParts });
    return card2({ template, icon: '', title, tags, elements: els }); // 问题卡不挂图标（橙色 lock 是权限专用）
}

/** ptsDevice → 简短终端 id：去 tmux:/dev/ 前缀，裁默认窗格后缀 :0.0（session 名已唯一），
 *  :N.M 非默认时保留以区分多窗格 */
function termLabel(ptsDevice) {
    if (!ptsDevice) return '';
    const t = String(ptsDevice);
    return (t.startsWith('tmux:') ? t.slice(5) : t.replace('/dev/', '')).replace(/:0\.0$/, '');
}

/** footer：仅留终端 id（多会话分辨用）；无终端则不要 footer。host/时间/项目都去掉，飞书自带消息时间 */
function footer(host, ptsDevice) {
    const term = termLabel(ptsDevice);
    if (!term) return null;
    return { tag: 'markdown', content: `<font color='grey'>${term}</font>` };
}

/** 中断按钮 + 终端 id 同行：左按钮、右灰字，省一行；无终端则退化为单按钮行 */
function escFooterRow(stateKey, ptsDevice) {
    const f = footer('', ptsDevice);
    const columns = [{ tag: 'column', width: 'auto', vertical_align: 'center', elements: [escButton(stateKey)] }];
    if (f) columns.push({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', horizontal_align: 'right', elements: [f] });
    return { tag: 'column_set', horizontal_spacing: '8px', columns };
}

module.exports = { card2, statsTags, inputEl, escButton, buttonRow, selectCard, footer, escFooterRow, termLabel };
