'use strict';

/**
 * 解析 markdown 内容，将表格块转换为飞书原生 table 元素
 * 飞书卡片的 tag:'markdown' 不支持渲染 markdown 表格，需要转换
 * @param {string} content
 * @returns {Array} 飞书卡片元素数组
 */
function parseMarkdownToElements(content) {
    if (!content) return [];

    const lines = content.split('\n');
    const elements = [];
    const textLines = [];
    let i = 0;

    const flushText = () => {
        const text = textLines.splice(0).join('\n').trimEnd();
        if (text) elements.push({ tag: 'markdown', content: text });
    };

    while (i < lines.length) {
        const line = lines[i];
        const nextLine = i + 1 < lines.length ? lines[i + 1] : '';

        // 识别 markdown 表格：当前行含 |...|，下一行是分隔符 |---|
        if (/^\s*\|/.test(line) && /^\s*\|[\s\-:|]+\|/.test(nextLine)) {
            flushText();

            // 收集连续的表格行
            const tableLines = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                tableLines.push(lines[i]);
                i++;
            }

            const tableEl = buildFeishuTable(tableLines);
            if (tableEl) {
                elements.push(tableEl);
            } else {
                // 解析失败时退化为代码块
                elements.push({ tag: 'markdown', content: '```\n' + tableLines.join('\n') + '\n```' });
            }
            continue;
        }

        textLines.push(line);
        i++;
    }

    flushText();
    return elements.length > 0 ? elements : [{ tag: 'markdown', content: content }];
}

/**
 * 将 markdown 表格行数组转换为飞书 table 元素
 * @param {string[]} lines - 包含 header、separator、data rows
 * @returns {Object|null}
 */
function buildFeishuTable(lines) {
    if (lines.length < 2) return null;

    const splitRow = (line) => {
        const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return trimmed.split('|').map(c => c.trim());
    };

    const headerCells = splitRow(lines[0]);
    if (!headerCells.length) return null;

    // 验证分隔行
    if (!/^[\s|:\-]+$/.test(lines[1])) return null;

    const dataRows = lines.slice(2)
        .filter(l => l.trim())
        .map(l => splitRow(l));

    if (dataRows.length === 0) return null;

    const columns = headerCells.map((header, idx) => ({
        name: `c${idx}`,
        display_name: header || `列${idx + 1}`,
        width: 'auto',
    }));

    const rows = dataRows.map(cells => {
        const row = {};
        headerCells.forEach((_, idx) => {
            row[`c${idx}`] = cells[idx] ?? '';
        });
        return row;
    });

    return {
        tag: 'table',
        page_size: rows.length,
        row_height: 'low',
        header_style: {
            text_align: 'left',
            text_size: 'normal',
            background_style: 'grey',
            text_color: 'default',
            bold: true,
            lines: 1,
        },
        columns,
        rows,
    };
}

/** 题干 markdown：**header**　question */
const questionHeading = q => ({ tag: 'markdown', content: `${q.header ? `**${q.header}**　` : ''}${q.question || ''}` });

/**
 * 多问题卡：一个 form 装下所有问题（单选 select_static / 多选 multi_select_static + 每题一个自定义 input），
 * 一次提交回调 form_value 全量返回。listener 收到后按题号顺序回放注入到 TUI 的 tab 式问卷。
 * @param {Array} questions - 每项含 header/question/multiSelect/options[{label}]/_contextText
 * @param {string} stateKey
 * @param {string} ptsDevice
 * @returns {Object} 飞书卡片 JSON
 */
function buildQuestionsForm(questions, stateKey, ptsDevice) {
    const { card2, escFooterRow } = require('./card');
    const contextText = questions[0]?._contextText || '';

    const formEls = [];
    questions.forEach((q, i) => {
        if (i > 0) formEls.push({ tag: 'hr' });
        formEls.push(questionHeading(q));
        const options = q.options.map((o, j) => ({ value: String(j), text: { tag: 'plain_text', content: o.label } }));
        formEls.push({
            tag: q.multiSelect ? 'multi_select_static' : 'select_static', name: `q${i}`,
            placeholder: { tag: 'plain_text', content: q.multiSelect ? '勾选（可多选）' : '点击选择' },
            options,
        });
        // 每题都给自定义框（"Type something"）：单选 Enter、多选文本+空格哨兵，均已验证可靠提交
        formEls.push({ tag: 'input', name: `q${i}_other`, placeholder: { tag: 'plain_text', content: '或自定义…（可选）' } });
    });
    formEls.push({
        tag: 'button', text: { tag: 'plain_text', content: '✅ 提交全部' }, type: 'primary',
        action_type: 'form_submit', name: 'submit',
        value: { action_type: 'submit_questions', session_state_key: stateKey },
    });

    const els = [];
    if (contextText) { els.push(...parseMarkdownToElements(contextText)); els.push({ tag: 'hr' }); }
    els.push({ tag: 'form', name: 'q_form', elements: formEls });
    els.push(escFooterRow(stateKey, ptsDevice)); // 中断 + 右侧终端 id（仿 Stop 卡）
    return card2({ template: 'orange', icon: 'list_outlined', title: `${questions.length} 个问题`, elements: els });
}

/**
 * 单题单选按钮卡：每个选项一个按钮（点一下即答，比下拉省两步）+ 自定义输入框 + 中断·终端id。
 * 回放仍走共用 buildReplayPlan：点 opt_i → 回放 {q0:i}；输入自定义 → 回放 {q0_other:文本}。
 * @param {Object} q - 含 header/question/options[{label}]/_contextText
 */
function buildSingleSelectCard(q, stateKey, ptsDevice) {
    const { card2, escFooterRow, inputEl } = require('./card');
    const els = [];
    const ctx = q._contextText || '';
    if (ctx) { els.push(...parseMarkdownToElements(ctx)); els.push({ tag: 'hr' }); }
    if (q.question) els.push(questionHeading(q));
    q.options.forEach((o, i) => els.push({
        tag: 'button', text: { tag: 'plain_text', content: o.label }, type: i === 0 ? 'primary' : 'default',
        value: { action_type: `opt_${i}`, session_state_key: stateKey },
    }));
    els.push(inputEl(stateKey, '或自定义…直接输入')); // 输入即走「Type something」
    els.push(escFooterRow(stateKey, ptsDevice));       // 中断 + 右侧终端 id（仿 Stop 卡）
    return card2({ template: 'orange', icon: 'list_outlined', title: q.header || '方案选择', elements: els });
}

/**
 * 提交完成卡（回调局部刷新）：把用户在飞书选/填的答案回显成绿色「已提交」卡，点完即时反馈、
 * 不依赖后续 patch。answers 兼容单选 {q0:"1"}、单选自定义 {q0_other:"…"}、多题 form_value 全量。
 * @param {Array<{header,options:string[],optionCount,multiSelect}>} questions - 即登记的 _questions（含选项 label）
 */
function buildSubmittedCard(questions, answers, ptsDevice) {
    const { card2, footer } = require('./card');
    const { selectedIndices } = require('./askq-replay');
    const lines = questions.map((q, i) => {
        const picks = selectedIndices(answers, i, q.optionCount, q.multiSelect).map(idx => q.options?.[idx] ?? `#${idx}`);
        const other = (answers[`q${i}_other`] || '').trim();
        if (other) picks.push(other);
        return `${q.header ? `**${q.header}**　` : ''}${picks.join('、') || '—'}`;
    });
    const els = [{ tag: 'markdown', content: lines.join('\n') }, footer('', ptsDevice)];
    return card2({ template: 'green', icon: 'yes_outlined', title: '已提交', elements: els }); // 对勾交给 header 绿色图标
}

module.exports = { parseMarkdownToElements, buildFeishuTable, buildQuestionsForm, buildSingleSelectCard, buildSubmittedCard };
