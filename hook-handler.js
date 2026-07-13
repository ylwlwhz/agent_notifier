'use strict';

// ftclaude 专用闸：只有 ftclaude 启动时会 export FTCLAUDE=1。
// 普通 tclaude 不设该变量 → hook 直接跳过，不加载发卡逻辑、不发飞书卡（保持 tclaude 原行为）。
if (process.env.FTCLAUDE === '1') {
    require('./src/apps/claude-hook');
}
