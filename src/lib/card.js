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

/** stats（成本/上下文/时长，均来自 statusLine 官方字段）→ header 彩色标签 */
function statsTags(stats, tagColor = 'grey') {
    if (!stats) return [];
    const tags = [];
    if (stats.costUSD > 0) tags.push({ text: `$${stats.costUSD.toFixed(2)}`, color: 'grey' });
    if (stats.contextPct != null) tags.push({ text: `🧠 ${stats.contextPct}%`, color: 'grey' });
    if (stats.duration) tags.push({ text: `⏱ ${stats.duration}`, color: tagColor });
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

/** AskUserQuestion 选择卡：context + 问题 + 竖排选项按钮 + 输入框 + 中断·终端id 行。
 *  mdToEls = parseMarkdownToElements（由调用方传入，避免 card.js ↔ feishu-card-utils 循环依赖） */
function selectCard({ template = 'orange', title, tags, contextText, question, options, stateKey, ptsDevice, mdToEls }) {
    const els = [];
    if (contextText) { els.push(...mdToEls(contextText)); els.push({ tag: 'hr' }); }
    if (question) els.push(...mdToEls(question));
    options.forEach((label, i) => els.push({ tag: 'button', text: { tag: 'plain_text', content: label }, type: i === 0 ? 'primary' : 'default', value: { action_type: `opt_${i}`, session_state_key: stateKey } }));
    els.push(inputEl(stateKey, '其他：直接输入自定义答案…')); // 输入即走 Other，listener 自动先移到 Type something
    els.push(escFooterRow(stateKey, ptsDevice)); // 中断按钮 + 右侧终端 id（仿 Stop 卡）
    return card2({ template, icon: 'list_outlined', title, tags, elements: els }); // 清单图标贴「选项列表」语义
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
