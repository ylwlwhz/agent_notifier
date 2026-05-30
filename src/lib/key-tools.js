'use strict';

/**
 * 执行摘要的「关键工具」集合 —— 唯一事实源。
 *
 * 两处共用、必须同源，否则叙述文字会被吞：
 *   - 蓝色 live 卡（claude-live）：用它锚定每段文字（只有挂上关键工具的文字段才展示）。
 *   - 绿色 Stop 卡（claude-hook）：用它作「收尾文字」的边界（只回收最后一个关键工具之后的文字）。
 * 若两边工具集不一致，夹在非关键工具（Read/Grep 等）前、最后一个关键工具之后的那段话会两头落空。
 *
 * 只收「有副作用 / 对外动作」的工具；Read/Grep/Glob 等纯本地只读不入列，避免摘要刷屏。
 */
const KEY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch']);

module.exports = { KEY_TOOLS };
