'use strict';

const app = require('./src/apps/cursor-hook');

if (require.main === module) {
    app.run();
}

module.exports = app;
