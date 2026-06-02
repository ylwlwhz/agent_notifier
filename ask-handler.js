'use strict';

const app = require('./src/apps/claude-ask');

if (require.main === module) {
    app.main().catch(err => { console.error('[ask-handler]', err.message); process.exit(0); });
}

module.exports = app;
