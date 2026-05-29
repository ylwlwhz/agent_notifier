'use strict';

// claude-ask 的 main 用 require.main 守卫（供 claude-hook 复用其导出而不触发 main），此处显式调用
require('./src/apps/claude-ask').main().catch(() => process.exit(0));
