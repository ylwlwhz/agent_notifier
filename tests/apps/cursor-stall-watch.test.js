'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const stall = require('../../src/apps/cursor-stall-watch');

const IDLE = 180000;

/** 造一份心跳记录；ageMs 表示「这条心跳是多久以前写的」 */
const beat = (event, ageMs, extra = {}) => ({
    ts: Date.now() - ageMs,
    event,
    stopped: false,
    session_key: 'abcd1234',
    ...extra,
});

test('上一件事已收尾却再无动静 → 告警（这正是卡在选择题的特征）', () => {
    assert.equal(stall.shouldAlert(beat('postToolUse', IDLE + 1000), IDLE), true);
});

test('还没到阈值不告警', () => {
    assert.equal(stall.shouldAlert(beat('postToolUse', IDLE - 1000), IDLE), false);
});

test('长活儿不会被误报：最后一个事件说明它正在干', () => {
    // 一条十分钟的编译命令同样是十分钟沉默，靠「沉默」单独判定必然误报，
    // 所以「开始干某件长事」的事件之后一律不报——干完了自然会有 postToolUse
    for (const event of ['beforeShellExecution', 'beforeMCPExecution', 'subagentStart']) {
        assert.equal(stall.shouldAlert(beat(event, IDLE * 5), IDLE), false, event);
    }
});

test('开着不用的新窗口不能误报：sessionStart 之后的沉默是正常的', () => {
    // 实测踩过：新开一个窗口什么都不干，3 分钟后就收到一张「疑似在等你确认」
    assert.equal(stall.shouldAlert(beat('sessionStart', IDLE * 10), IDLE), false);
});

test('判据不能写成「必须是 afterAgentResponse」：那样永远不会告警', () => {
    // afterAgentResponse 实测只在一轮结束时触发，而卡住的那轮永远不会结束。
    // 这条用例钉住的是「思考事件之后的沉默也要能报」。
    assert.equal(stall.shouldAlert(beat('afterAgentThought', IDLE + 1), IDLE), true);
});

test('未知/新增事件默认不告警（允许清单，不是排除清单）', () => {
    // 以后为刷心跳再注册什么观测类事件，都不该自动变成告警源
    for (const event of ['preCompact', 'sessionEnd', 'somethingNew', '']) {
        assert.equal(stall.shouldAlert(beat(event, IDLE * 5), IDLE), false, event || '(空)');
    }
});

test('本轮已正常收尾的一律不报', () => {
    const heartbeat = beat('postToolUse', IDLE * 3, { stopped: true });
    assert.equal(stall.shouldAlert(heartbeat, IDLE), false);
});

test('心跳缺失/残缺时不报，绝不能因为读不到文件就乱发卡', () => {
    assert.equal(stall.shouldAlert(null, IDLE), false);
    assert.equal(stall.shouldAlert({}, IDLE), false);
    assert.equal(stall.shouldAlert({ event: 'postToolUse' }, IDLE), false);
    assert.equal(stall.shouldAlert({ ts: Date.now() - IDLE - 1 }, IDLE), false);
});

test('recordActivity 落盘的字段够渲染告警卡；stop 后 clearActivity 清干净', () => {
    const event = {
        sessionKey: 'zz998877',
        sessionId: 'cursor_zz998877',
        meta: {
            eventName: 'afterAgentResponse',
            projectName: 'demo',
            model: 'claude-opus-5',
            workspaceRoot: '/tmp/demo',
        },
    };

    stall.recordActivity(event);
    const written = JSON.parse(fs.readFileSync(stall.activityPath('zz998877'), 'utf8'));
    assert.equal(written.event, 'afterAgentResponse');
    assert.equal(written.session_key, 'zz998877');
    assert.equal(written.project, 'demo');
    assert.equal(written.model, 'claude-opus-5');
    assert.equal(written.stopped, false);
    assert.equal(stall.shouldAlert({ ...written, ts: Date.now() - IDLE - 1 }, IDLE), true);

    stall.clearActivity('zz998877');
    assert.equal(fs.existsSync(stall.activityPath('zz998877')), false);
    assert.equal(fs.existsSync(stall.lockPath('zz998877')), false);
});

test('ensureWatcher 不重复拉起：已有活着的看门狗就直接返回 false', () => {
    const key = 'yy112233';
    stall.clearActivity(key);
    // 用当前进程冒充「活着的看门狗」——pid 一定存活，避免真去 spawn 子进程
    fs.writeFileSync(stall.lockPath(key), JSON.stringify({ pid: process.pid, started_at: Date.now() }));

    assert.equal(stall.ensureWatcher(key, IDLE), false);
    stall.clearActivity(key);
});

test('抢锁是原子的：并发只有一个能武装（实测抢出过两个看门狗）', () => {
    const key = 'cc445566';
    stall.clearActivity(key);
    // 先手工占住锁但不写内容，模拟「另一个进程刚 open(wx) 成功、还没写 pid」的瞬间。
    // 旧实现是「读锁→spawn→写锁」，此刻读到的是空内容 → 会再 spawn 一个。
    fs.closeSync(fs.openSync(stall.lockPath(key), 'wx'));

    assert.equal(stall.ensureWatcher(key, IDLE), false, '锁已被占，不该再拉起第二个');
    stall.clearActivity(key);
});

test('死锁能被回收：持锁进程已消失时允许重新武装', () => {
    const key = 'dd778899';
    stall.clearActivity(key);
    // pid 1 之外找一个几乎不可能存在的 pid
    fs.writeFileSync(stall.lockPath(key), JSON.stringify({ pid: 2147483, started_at: Date.now() }));

    // 这里会真 spawn 一个看门狗；它读不到心跳文件就立刻退出，不会发卡
    assert.equal(stall.ensureWatcher(key, IDLE), true);
    stall.clearActivity(key);
});

// ── 抑制规则：已有卡在外面就不叠噪音 ────────────────────────────────────────

test('hasPendingCard：该会话已有待回复的卡时返回 true，用户并非两眼一抹黑', () => {
    const { decisionBridge } = require('../../src/lib/decision-bridge');
    const id = 'cursor_stallsuppress_1';
    decisionBridge.open(id, { session_id: 'cursor_S9', event: 'stop', timeoutMs: 60000 });
    try {
        assert.equal(stall.hasPendingCard('cursor_S9'), true);
        assert.equal(stall.hasPendingCard('cursor_别的'), false);
        assert.equal(stall.hasPendingCard(''), false, '没有会话 id 时不该乱抑制');
    } finally {
        decisionBridge.close(id);
    }
});
