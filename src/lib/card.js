'use strict';

// schema 2.0 卡片构建公共件。交互组件的 value:{action_type,session_state_key} 结构与 1.0 一致，
// listener 回调路由不受影响；2.0 取消了 action 容器，按钮改用 column_set 横排、输入框直接入 body。

const { formatTokenCount } = require('./card-footer');

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

/** 把 stats（时长 + token）转成 header 彩色标签，从 footer 上移过来避免重复 */
function statsTags(stats, tagColor = 'grey') {
    const tags = [];
    if (stats?.duration) tags.push({ text: `⏱ ${stats.duration}`, color: tagColor });
    const out = formatTokenCount(stats?.outputTokens);
    if (out) tags.push({ text: `📊 ${out} tok`, color: 'grey' });
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
    options.forEach((label, i) => els.push({ tag: 'button', text: { tag: 'plain_text', content: label }, type: i === 0 ? 'primary' : 'default', value: { action_type: `opt_${i}`, session_state_key: stateKey } }));
    els.push({ tag: 'button', text: { tag: 'plain_text', content: '💬 Other' }, type: 'default', value: { action_type: 'opt_other', session_state_key: stateKey } });
    els.push(inputEl(stateKey, '输入自定义回答...'));
    els.push(escButton(stateKey));
    if (noteParts) els.push({ tag: 'markdown', content: noteParts });
    return card2({ template, icon: '', title, tags, elements: els }); // 问题卡不挂图标（橙色 lock 是权限专用）
}

/** footer：仅留终端 id（多会话分辨用）；无终端则不要 footer。host/时间/项目都去掉，飞书自带消息时间 */
function footer(host, ptsDevice) {
    if (!ptsDevice) return null;
    const t = String(ptsDevice);
    const term = t.startsWith('tmux:') ? t.slice(5) : t.replace('/dev/', '');
    return { tag: 'markdown', content: `<font color='grey'>🖥 ${term}</font>` };
}

module.exports = { card2, statsTags, inputEl, escButton, buttonRow, selectCard, footer };
