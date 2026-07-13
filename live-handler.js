'use strict';

// ftclaude 专用闸：见 hook-handler.js 注释。普通 tclaude 不设 FTCLAUDE → 跳过。
if (process.env.FTCLAUDE === '1') {
    require('./src/apps/claude-live');
}
