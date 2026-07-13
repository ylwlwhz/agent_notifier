'use strict';

const app = require('./src/apps/claude-ask');

// ftclaude 专用闸：见 hook-handler.js 注释。普通 tclaude 不设 FTCLAUDE → 不触发发卡。
if (require.main === module && process.env.FTCLAUDE === '1') {
    app.main().catch(err => { console.error('[ask-handler]', err.message); process.exit(0); });
}

module.exports = app;
