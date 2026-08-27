#!/usr/bin/env node
'use strict';

/**
 * Cursor 飞书卡片真机验证。
 *
 * 与 Codex 的同类脚本不同，本脚本【走的就是生产代码路径】（cursor-hook.askFeishu）：
 * 它真的开一个 decision-bridge 请求、真的发卡、真的阻塞等你点——所以你在飞书上点
 * 一下，就等于完整验证了「卡片渲染 → 回调路由 → 决策回流 → 卡片收敛」整条链路，
 * 而不只是看一眼卡片长什么样。
 *
 * 前置：feishu-listener 必须在跑，否则点了没人处理，只能等超时。
 *
 * 用法:
 *   node scripts/send-cursor-feishu-test-cards.js              # 通知卡 + 审批卡 + 完成卡
 *   node scripts/send-cursor-feishu-test-cards.js --approval    # 只验审批（阻塞等你点）
 *   node scripts/send-cursor-feishu-test-cards.js --followup    # 只验续写（阻塞等你回话）
 *   node scripts/send-cursor-feishu-test-cards.js --notify      # 只验只读通知卡，不阻塞
 *   node scripts/send-cursor-feishu-test-cards.js --timeout 60  # 自定义等待秒数
 */

require('../src/lib/env-config');
const path = require('node:path');

const { translateCursorHook } = require('../src/adapters/cursor/hook-adapter');
const cursorHook = require('../src/apps/cursor-hook');
const cards = require('../src/apps/cursor-cards');

function parseArg(name, fallback = null) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return fallback;
    return process.argv[idx + 1] || fallback;
}

const projectName = path.basename(process.cwd());
const workspaceRoot = process.cwd();
const CONVERSATION_ID = `e2e-${Date.now()}`;

/** 造一个和真实 hook 事件同形的 payload，翻译走的也是生产 adapter */
function makeEvent(payload) {
    return translateCursorHook({
        conversation_id: CONVERSATION_ID,
        generation_id: 'gen-e2e',
        model_id: 'cursor-e2e-model',
        cursor_version: 'e2e',
        workspace_roots: [workspaceRoot],
        ...payload,
    });
}

async function sendPlainCard(app, card) {
    await app.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
}

/** 只读通知卡：失败卡 + 实时摘要卡 + 纯通知完成卡，看渲染即可，不需要点 */
async function verifyNotifyCards(app) {
    const failure = makeEvent({
        hook_event_name: 'postToolUseFailure',
        tool_name: 'Shell',
        tool_input: { command: 'npm run e2e' },
        error_message: 'Command timed out after 30s',
        failure_type: 'timeout',
    });
    await sendPlainCard(app, cards.buildFailureCard({ event: failure }));
    console.log('  ✔ 失败卡（红）已发送');

    const live = makeEvent({ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'npm test' } });
    await sendPlainCard(app, cards.buildLiveCard({
        segments: [{
            text: '先跑一遍测试，然后改一处实现。',
            tools: [
                { tool: 'Shell', icon: '⚡', input: 'npm test -- --reporter=dot', result: '208 passing' },
                { tool: 'StrReplace', icon: '✏️', input: 'src/apps/cursor-hook.js', result: '' },
            ],
        }],
        capture: { tools: true, output: true, results: true },
        model: live.meta.model,
        projectName,
    }));
    console.log('  ✔ 实时摘要卡（靛蓝、工具默认折叠、无输入框）已发送');

    const stop = makeEvent({ hook_event_name: 'stop', status: 'completed' });
    await sendPlainCard(app, cards.buildFollowupCard({
        event: stop, stateKey: null, body: '任务已完成（纯通知形态，无交互组件）。', timeoutMs: 0, waiting: false,
    }));
    console.log('  ✔ 完成卡（纯通知形态）已发送');
}

/** 审批卡：真的阻塞等你点，点完打印 Cursor 会收到的裁决 */
async function verifyApproval(app, timeoutMs) {
    const event = makeEvent({
        hook_event_name: 'beforeShellExecution',
        command: 'rm -rf build && npm run deploy -- --prod',
        cwd: workspaceRoot,
        sandbox: false,
    });

    console.log(`\n[审批] 已发卡，正在等你在飞书上点（最多 ${Math.round(timeoutMs / 1000)}s）…`);
    console.log('       可点「允许」/「拒绝」/「本地确认」，或在输入框里写拒绝理由');

    const decision = await cursorHook.askFeishu({
        event,
        app,
        timeoutMs,
        responses: cards.approvalResponses(),
        textResponse: { field: 'agent_message', extra: { permission: 'deny' } },
        notificationType: 'cursor_e2e_approval',
        buildCard: (stateKey) => cards.buildApprovalCard({ event, stateKey, timeoutMs }),
    });

    report('审批', decision, 'beforeShellExecution');
}

/** 完成卡：真的阻塞等你回话，回话内容会变成 followup_message */
async function verifyFollowup(app, timeoutMs) {
    const event = makeEvent({ hook_event_name: 'stop', status: 'completed', loop_count: 0 });

    console.log(`\n[续写] 已发卡，正在等你在飞书上回话（最多 ${Math.round(timeoutMs / 1000)}s）…`);
    console.log('       在输入框里打字 = 让 Cursor 自动继续下一轮；点「结束本轮」= 就地收尾');

    const decision = await cursorHook.askFeishu({
        event,
        app,
        timeoutMs,
        responses: cards.followupResponses(),
        textResponse: { field: 'followup_message' },
        notificationType: 'cursor_e2e_followup',
        buildCard: (stateKey) => cards.buildFollowupCard({
            event, stateKey, body: '这是一张真机验证用的完成卡，回话内容会原样变成 followup_message。',
            timeoutMs, waiting: true,
        }),
    });

    report('续写', decision, 'stop');
}

function report(label, decision, eventName) {
    const { renderHookOutput } = require('../src/adapters/cursor/control-policy');
    if (decision === null) {
        console.log(`  ⏳ ${label}超时：未收到飞书回应。真实 hook 此时会回落到本地（审批 → Cursor 自己弹窗）。`);
        console.log('     若你确实点了却没生效，先查 feishu-listener 是否在跑、是否只有一个实例。');
        return;
    }
    console.log(`  ✔ ${label}已收到裁决:`, JSON.stringify(decision));
    console.log('    Cursor 实际会读到:', JSON.stringify(renderHookOutput(eventName, decision)));
}

async function main() {
    const app = await cursorHook.getFeishuApp();
    if (!app) {
        throw new Error('无法初始化飞书：请检查 .env 里的 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
    }

    const timeoutMs = Math.max(5, parseFloat(parseArg('--timeout', '120')) || 120) * 1000;
    const only = {
        notify: process.argv.includes('--notify'),
        approval: process.argv.includes('--approval'),
        followup: process.argv.includes('--followup'),
    };
    const all = !only.notify && !only.approval && !only.followup;

    console.log(`[cursor-e2e] 会话 ${CONVERSATION_ID} · 项目 ${projectName}`);

    if (all || only.notify) {
        console.log('\n[通知] 发送只读卡片…');
        await verifyNotifyCards(app);
    }
    if (all || only.approval) await verifyApproval(app, timeoutMs);
    if (all || only.followup) await verifyFollowup(app, timeoutMs);

    console.log('\n[cursor-e2e] 完成。审批/完成卡在拿到裁决或超时后都应已 patch 成「已处理」形态。');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[cursor-e2e] 失败:', err.message);
        process.exit(1);
    });
}
