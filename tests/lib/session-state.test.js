'use strict';

/**
 * SessionState 跨进程并发安全测试
 *
 * 核心回归场景：flush 类进程「load 旧快照 → await 网络 → save 整表回写」
 * 会把窗口期内其他进程 addNotification 的键清掉（飞书卡片随机「已失效」的根因）。
 * mutate()/mutateAsync() 在锁内 fresh load 后只改自己的键，必须保留并发新增。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SessionState } = require('../../src/lib/session-state');

function makeTempState() {
    const p = `/tmp/test-session-state-${process.pid}-${Math.floor(performance.now() * 1000)}.json`;
    return { state: new SessionState(p), path: p };
}

test('mutateAsync 保留其他进程在快照后新增的键', async () => {
    const { state: a, path } = makeTempState();
    const b = new SessionState(path); // 模拟另一进程

    // A 先读快照（flush 决策阶段）
    a.load();

    // B 在 A 的"网络窗口"期间写入一条通知
    await b.addNotificationAsync('feishu_new_key', { created_at: Date.now(), pts_device: '/dev/pts/9' });

    // A 用 mutateAsync 写回自己的键 —— 不得清掉 B 的新增
    await a.mutateAsync((data) => {
        data['live_msg_abc'] = { message_id: 'om_1', created_at: Date.now() };
    });

    const check = new SessionState(path).load();
    assert.ok(check.data['feishu_new_key'], '并发新增的通知不能被 mutateAsync 覆盖掉');
    assert.equal(check.data['live_msg_abc'].message_id, 'om_1');
    fs.unlinkSync(path);
});

test('旧写法（快照直接 save）确实会丢并发新增 —— 佐证必须走 mutate', async () => {
    const { state: a, path } = makeTempState();
    const b = new SessionState(path);

    a.load(); // A 持旧快照
    await b.addNotificationAsync('feishu_new_key', { created_at: Date.now() });

    a.data['live_msg_abc'] = { message_id: 'om_1' };
    a.save(); // 整表回写旧快照

    const check = new SessionState(path).load();
    assert.equal(check.data['feishu_new_key'], undefined, '旧写法预期丢失（该测试锁定问题模式）');
    fs.unlinkSync(path);
});

test('mutate 返回 false 时跳过保存', () => {
    const { state, path } = makeTempState();
    state.mutate((data) => { data['k'] = 1; });
    state.mutate((data) => { data['k'] = 2; return false; });
    const check = new SessionState(path).load();
    assert.equal(check.data['k'], 1);
    fs.unlinkSync(path);
});

test('mutate 内可删除键（received_msg 消费场景）', async () => {
    const { state, path } = makeTempState();
    await state.mutateAsync((data) => {
        data['received_msg_ab12cd34'] = { message_id: 'om_r', created_at: Date.now() };
        data['other'] = 1;
    });
    await state.mutateAsync((data) => {
        delete data['received_msg_ab12cd34'];
        data['live_msg_ab12cd34'] = { message_id: 'om_r', created_at: Date.now() };
    });
    const check = new SessionState(path).load();
    assert.equal(check.data['received_msg_ab12cd34'], undefined);
    assert.ok(check.data['live_msg_ab12cd34']);
    assert.equal(check.data['other'], 1);
    fs.unlinkSync(path);
});
