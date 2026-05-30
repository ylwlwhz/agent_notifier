'use strict';

/**
 * AskUserQuestion 回放规划器 —— 单选/多选/多题、预定义/自定义全部统一在此。
 *
 * 飞书表单一次收齐答案后，要把它"回放"成键盘序列注入 Claude Code 的 TUI 问卷。
 * 这里是纯函数：输入题目元数据 + 答案，输出一串原子按键步骤；listener 负责执行（注入 + 间隔）。
 * 把"算什么键"和"怎么发键"分开，逻辑可单测、各入口共用。
 *
 * 实测的 TUI 模型（Claude Code 2.1.158，键序均经真机验证）：
 *   - 多题 = 顶部 tab 栏（每题一 tab + 末尾 Submit tab），←/→ 切 tab，每进一个 tab 选项高亮回到 0。
 *   - 单题单选：选中即完成，无 Submit tab。单题多选：勾选后才出现 Submit tab。
 *   - 单选：Down×idx + Enter → 提交并自动跳下一 tab（单题时即完成）。
 *       自定义("Type something" = 第 len 项)：移到该项【直接打字】（不先按 Enter）+ Enter 提交。
 *   - 多选：Down 导航、Enter 切换勾选（光标留选项行、不前进），作答后 → 手动切 tab。
 *       自定义：移到「Type something」注入文本 + 一个【空格哨兵】。该输入框 commit 滞后一个 keypress：
 *               哨兵把真实最后一字 commit 进 state（哨兵自身 pending、不进答案）；导航键不触发 commit，
 *               故 Down→行内Submit、Up→文本行、Up→普通选项行后 → 切 tab，state 稳保（整串可一次注入，无需逐字）。
 *   - 收尾：存在 Submit tab（多题，或含任一多选题）时，最后落在 Submit tab，Enter 选「Submit answers」。
 */

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const RIGHT = '\x1b[C';
const ENTER = '\r';

/** 解析某题选中的选项下标（升序、去非法）。单选取单值、多选取数组，统一成 number[] */
function selectedIndices(answers, i, optionCount, multiSelect) {
    const raw = multiSelect ? (answers[`q${i}`] || []) : (answers[`q${i}`] != null ? [answers[`q${i}`]] : []);
    return raw.map(Number)
        .filter(n => Number.isInteger(n) && n >= 0 && n < optionCount)
        .sort((a, b) => a - b);
}

/** 某题是否已答（提交前校验，避免某 tab 无法前进/提交）。勾选或自定义文本均算已答 */
function isAnswered(answers, i, q) {
    if (selectedIndices(answers, i, q.optionCount, q.multiSelect).length) return true;
    return !!(answers[`q${i}_other`] || '').trim();
}

/** 第一道未答题的序号（从 0 起）；全答返回 -1 */
function firstUnanswered(answers, questions) {
    return questions.findIndex((q, i) => !isAnswered(answers, i, q));
}

/**
 * 规划回放按键。
 * @param {Array<{multiSelect:boolean, optionCount:number}>} questions
 * @param {Object} answers - 飞书 form_value：{q0:"1", q0_other:"...", q1:["0","2"], ...}
 * @returns {Array<{keys?:string, text?:string, submit?:boolean, multiCustom?:string, pause?:number}>}
 *   keys=注入原始字节；text+submit=打字并回车（单选自定义）；multiCustom=文本+空格哨兵（多选自定义）。
 */
function buildReplayPlan(questions, answers) {
    const steps = [];
    const hasSubmitTab = questions.length > 1 || questions.some(q => q.multiSelect);

    questions.forEach((q, i) => {
        const len = q.optionCount;
        const other = (answers[`q${i}_other`] || '').trim();
        const sel = selectedIndices(answers, i, len, q.multiSelect);

        if (q.multiSelect) {
            // 逐个 Down 到选中项、Enter 切勾选；光标停在最后一个勾选项
            let pos = 0;
            for (const idx of sel) {
                if (idx > pos) steps.push({ keys: DOWN.repeat(idx - pos) });
                steps.push({ keys: ENTER }); // 切换勾选（不前进）
                pos = idx;
            }
            if (other) {
                if (len > pos) steps.push({ keys: DOWN.repeat(len - pos) }); // 到「Type something」
                steps.push({ multiCustom: other });                         // 文本 + 空格哨兵
                steps.push({ keys: DOWN }, { keys: UP }, { keys: UP });      // 退输入态回普通选项行
            }
            steps.push({ keys: RIGHT, pause: 360 }); // 多选不自动跳，手动切下一 tab
        } else if (other) {
            steps.push({ keys: DOWN.repeat(len) });                 // 到「Type something」（不按 Enter）
            steps.push({ text: other, submit: true, pause: 360 });  // 打字 + Enter：提交并前进/完成
        } else {
            const idx = sel.length ? sel[0] : 0;
            if (idx > 0) steps.push({ keys: DOWN.repeat(idx) });
            steps.push({ keys: ENTER }); // 单选 Enter：提交并前进/完成
        }
    });

    if (hasSubmitTab) steps.push({ keys: ENTER }); // 末尾停在 Submit tab，Enter 选「Submit answers」
    return steps;
}

module.exports = { buildReplayPlan, selectedIndices, isAnswered, firstUnanswered };
