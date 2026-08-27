'use strict';

/**
 * 回归测试：发卡与写 state 的顺序。
 *
 * 用户长期反馈「用的就是最新卡片回复，却提示卡片已过期」。根因是发卡先于写
 * state：卡片在飞书上已经可点，但通知还没落盘，这期间点击查不到通知 → 误报
 * 「已过期」。实测该窗口 1.0-5.3s（一次飞书 API 往返，state key 内嵌的发卡
 * 时间戳与 created_at 之差可直接量出来），回得越快越容易撞上。
 *
 * 这里用「发送过程中回头查 state」来锁住顺序：send 的桩函数在被调用时立刻
 * 查询通知是否已可见，可见才算通过。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionState } = require('../../src/lib/session-state');

function tmpState() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-order-'));
    return { file: path.join(dir, 's.json'), dir };
}

/** 造一个 app 桩：发送时回调 onSend（用于在「发送中」这一刻检查 state） */
function fakeApp(onSend, { fail = false } = {}) {
    return {
        chatId: 'chat-x',
        client: {
            im: {
                message: {
                    create: async () => {
                        if (onSend) await onSend();
                        if (fail) throw new Error('feishu 5xx');
                        return { data: { message_id: 'msg-1' } };
                    },
                },
            },
        },
    };
}

test('claude-ask 单选卡：发送时通知已可见（不再有竞态窗口）', async () => {
    const { file, dir } = tmpState();
    try {
        const state = new SessionState(file);
        const ask = require('../../src/apps/claude-ask');
        const stateKey = 'feishu_ask_order_1';
        let visibleDuringSend = null;

        const app = fakeApp(async () => {
            // 模拟用户在「卡片已发出、API 还没返回」的窗口内点击
            visibleDuringSend = !!state.getNotification(stateKey);
        });

        await ask.sendSingleSelectCard(
            app,
            { header: 'H', question: 'Q', options: [{ label: 'A' }, { label: 'B' }] },
            stateKey, '/dev/ttys9', 'sess-1', 'AskUserQuestion', [], { state },
        );

        assert.equal(visibleDuringSend, true,
            '发卡的那一刻通知就应已落盘，否则窗口内点击会误报「卡片已过期」');
        assert.ok(state.getNotification(stateKey), '发送成功后通知仍在');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('claude-ask 多选卡：发送时通知已可见，且事后补上 _message_id', async () => {
    const { file, dir } = tmpState();
    try {
        const state = new SessionState(file);
        const ask = require('../../src/apps/claude-ask');
        const stateKey = 'feishu_ask_order_2';
        let visibleDuringSend = null;

        const app = fakeApp(async () => {
            visibleDuringSend = !!state.getNotification(stateKey);
        });

        await ask.sendMultiSelectCard(
            app,
            { question: 'Q', options: [{ label: 'A' }, { label: 'B' }] },
            stateKey, '/dev/ttys9', 'sess-1', 'AskUserQuestion', [], { state },
        );

        assert.equal(visibleDuringSend, true, '多选卡同样不能有竞态窗口');
        const entry = state.getNotification(stateKey);
        assert.equal(entry._message_id, 'msg-1',
            '_message_id 只能在发送后得知，应在发完补写（form 回调反查要用）');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('发送失败要回滚，不留下等不到卡片的孤儿通知', async () => {
    const { file, dir } = tmpState();
    try {
        const state = new SessionState(file);
        const ask = require('../../src/apps/claude-ask');
        const stateKey = 'feishu_ask_order_3';
        const app = fakeApp(null, { fail: true });

        await ask.sendSingleSelectCard(
            app,
            { header: 'H', question: 'Q', options: [{ label: 'A' }] },
            stateKey, '/dev/ttys9', 'sess-1', 'AskUserQuestion', [], { state },
        );

        assert.equal(state.getNotification(stateKey), null,
            '卡片没发出去，就不该留着通知——否则它会一直占位直到 24h 过期');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
