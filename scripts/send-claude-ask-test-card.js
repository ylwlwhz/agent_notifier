'use strict';

// e2e 手动发卡：往飞书发一张单题单选按钮卡，验证 AskUserQuestion 链路。用法：npm run ask:e2e:card

require('../src/lib/env-config');

const { resolvePtsDevice } = require('../src/lib/terminal-inject');
const { getFeishuAppClient, sendSingleSelectCard } = require('../src/apps/claude-ask');

async function main() {
    const app = await getFeishuAppClient();
    if (!app) {
        console.error('[send-claude-ask-test-card] 飞书配置缺失');
        process.exit(1);
    }

    await sendSingleSelectCard(
        app,
        {
            header: '方案选择',
            question: '请选择本轮回归验证要走的方案',
            options: [{ label: '测试选项一' }, { label: '测试选项二' }],
        },
        `feishu_ask_test_${Date.now()}`,
        resolvePtsDevice(process.pid),
        'test-session',
        'AskUserQuestion',
    );

    console.log('[send-claude-ask-test-card] 已发送方案选择卡片');
}

main().catch(err => {
    console.error('[send-claude-ask-test-card]', err.message);
    process.exit(1);
});
