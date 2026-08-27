'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DecisionBridge, newDecisionId } = require('../../src/lib/decision-bridge');

function tempBridge() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-bridge-'));
    return { bridge: new DecisionBridge(dir), dir };
}

test('open → resolve → wait 拿到裁决', async () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();

    bridge.open(id, { host: 'cursor' });
    assert.equal(bridge.isPending(id), true);

    assert.equal(bridge.resolve(id, { permission: 'allow' }), true);
    assert.equal(bridge.isPending(id), false);

    assert.deepEqual(await bridge.wait(id, { timeoutMs: 500 }), { permission: 'allow' });
});

test('空裁决也算裁决（「结束本轮」就是不给 followup_message）', async () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    bridge.open(id);
    bridge.resolve(id, {});

    const decision = await bridge.wait(id, { timeoutMs: 500 });
    assert.deepEqual(decision, {});
    assert.notEqual(decision, null, '空对象不能被当成超时');
});

test('无人作答时 wait 超时返回 null，让调用方回落', async () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    bridge.open(id);

    const started = Date.now();
    assert.equal(await bridge.wait(id, { timeoutMs: 200, pollMs: 20 }), null);
    assert.ok(Date.now() - started >= 190, '应当真的等满超时');
});

test('等待过程中写入的裁决能被读到', async () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    bridge.open(id);

    const timer = setTimeout(() => bridge.resolve(id, { followup_message: '继续' }), 60);
    const decision = await bridge.wait(id, { timeoutMs: 2000, pollMs: 20 });
    clearTimeout(timer);

    assert.deepEqual(decision, { followup_message: '继续' });
});

test('没有人在等时 resolve 返回 false —— listener 据此如实告知用户', () => {
    const { bridge } = tempBridge();
    assert.equal(bridge.resolve('never-opened', { permission: 'allow' }), false);
});

test('重复 resolve 只认第一次，避免两次点击互相覆盖', () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    bridge.open(id);

    assert.equal(bridge.resolve(id, { permission: 'allow' }), true);
    assert.equal(bridge.resolve(id, { permission: 'deny' }), false);
    assert.deepEqual(bridge.read(id), { permission: 'allow' });
});

test('close 清掉请求与回复，wait 之后不再残留文件', async () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    bridge.open(id);
    bridge.resolve(id, { permission: 'allow' });
    await bridge.wait(id, { timeoutMs: 100 });

    bridge.close(id);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('cleanExpired 清掉 hook 被 kill 留下的残留', () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    bridge.open(id);

    const stale = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, `${id}.request.json`), stale, stale);

    assert.equal(bridge.cleanExpired(30 * 60 * 1000), 1);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('长等待不会被按龄清理误删 —— 12h 场景的核心回归', () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    // hook 声明要等 12 小时
    bridge.open(id, { timeoutMs: 12 * 3600 * 1000 });

    // 文件写在 1 小时前，远超 30 分钟的兜底阈值
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(path.join(dir, `${id}.request.json`), old, old);

    assert.equal(bridge.cleanExpired(30 * 60 * 1000), 0, 'hook 还在等，不能删');
    assert.equal(bridge.isPending(id), true);
    // 关键：几小时后用户点卡片仍然能把裁决交出去
    assert.equal(bridge.resolve(id, { followup_message: '继续' }), true);
});

test('声明的截止时间过了（含宽限）才清理', () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    bridge.open(id, { timeoutMs: 1000 });

    // 刚过期但还在宽限期内：hook 可能正要察觉超时并 close，别抢它
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${id}.request.json`), 'utf8'));
    rec.expires_at = Date.now() - 5 * 1000;
    fs.writeFileSync(path.join(dir, `${id}.request.json`), JSON.stringify(rec));
    assert.equal(bridge.cleanExpired(), 0, '宽限期内不清');

    // 远超宽限期 → 清掉
    rec.expires_at = Date.now() - 10 * 60 * 1000;
    fs.writeFileSync(path.join(dir, `${id}.request.json`), JSON.stringify(rec));
    assert.equal(bridge.cleanExpired(), 1);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('清理按 id 成对处理，不会只删走回复把等待方饿死', () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    bridge.open(id, { timeoutMs: 12 * 3600 * 1000 });
    bridge.resolve(id, { permission: 'allow' });

    // 把两个文件的 mtime 都推老
    const old = new Date(Date.now() - 3600 * 1000);
    for (const suffix of ['request', 'reply']) {
        fs.utimesSync(path.join(dir, `${id}.${suffix}.json`), old, old);
    }

    assert.equal(bridge.cleanExpired(30 * 60 * 1000), 0);
    assert.deepEqual(bridge.read(id), { permission: 'allow' }, '裁决必须还在，等待方要能读到');
});

test('没声明截止时间的老记录仍按龄兜底清理', () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    bridge.open(id); // 不带 timeoutMs

    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(path.join(dir, `${id}.request.json`), old, old);

    assert.equal(bridge.cleanExpired(30 * 60 * 1000), 1);
});

/** 造一个「等待方已死」的请求：用一个必然不存在的 pid */
function killedWaiter(bridge, id, timeoutMs = 12 * 3600 * 1000) {
    bridge.open(id, { timeoutMs });
    const file = path.join(bridge.dir, `${id}.request.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.pid = 2147483000; // 远超 pid_max，不可能存在
    fs.writeFileSync(file, JSON.stringify(rec));
}

test('等待方已死（Cursor 被关掉）→ resolve 如实回 false，不假报成功', () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    killedWaiter(bridge, id);

    assert.equal(bridge.isPending(id), false, '进程没了就不该报「还在等」');
    assert.equal(bridge.resolve(id, { followup_message: '继续' }), false);
    assert.equal(bridge.read(id), null, '不该留下没人读的裁决');
});

test('等待方已死的残留立即可回收，不用陪着 12h 的 expires_at 干等', () => {
    const { bridge, dir } = tempBridge();
    const id = newDecisionId();
    killedWaiter(bridge, id);

    assert.equal(bridge.cleanExpired(), 1);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('等待方存活时 resolve 正常（存活探测不能把正常路径也拦掉）', () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    bridge.open(id, { timeoutMs: 60_000 }); // pid = 当前进程，必然存活

    assert.equal(bridge.isPending(id), true);
    assert.equal(bridge.resolve(id, { permission: 'allow' }), true);
});

test('跨主机的请求不做 pid 判断（远程工作区里 pid 没有可比性）', () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    bridge.open(id, { timeoutMs: 60_000 });

    const file = path.join(bridge.dir, `${id}.request.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.hostname = 'some-other-machine';
    rec.pid = 2147483000;
    fs.writeFileSync(file, JSON.stringify(rec));

    assert.equal(bridge.isPending(id), true, '不同主机应按「还活着」处理，退回超时兜底');
    assert.equal(bridge.resolve(id, { permission: 'allow' }), true);
});

test('open 把 timeoutMs 换算成 expires_at 落盘，且不把它当普通 meta 写进去', () => {
    const { bridge } = tempBridge();
    const id = newDecisionId();
    const before = Date.now();
    bridge.open(id, { timeoutMs: 90_000, host: 'cursor' });

    const rec = bridge.getRequest(id);
    assert.equal(rec.host, 'cursor');
    assert.equal(rec.timeoutMs, undefined, 'timeoutMs 不该原样落盘，只落 expires_at');
    assert.ok(rec.expires_at >= before + 90_000);
    assert.ok(rec.expires_at <= Date.now() + 90_000);
});

test('AGENT_NOTIFIER_DECISIONS 可覆盖目录，默认落在共享 /tmp', () => {
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-env-'));
    const prev = process.env.AGENT_NOTIFIER_DECISIONS;
    process.env.AGENT_NOTIFIER_DECISIONS = custom;
    try {
        const bridge = new DecisionBridge();
        assert.equal(bridge.dir, custom);
    } finally {
        if (prev === undefined) delete process.env.AGENT_NOTIFIER_DECISIONS;
        else process.env.AGENT_NOTIFIER_DECISIONS = prev;
    }

    delete process.env.AGENT_NOTIFIER_DECISIONS;
    assert.match(new DecisionBridge().dir, /agent-notifier-decisions$/);
    if (prev !== undefined) process.env.AGENT_NOTIFIER_DECISIONS = prev;
});

test('决策 id 唯一，同毫秒也不碰撞', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDecisionId('cursor')));
    assert.equal(ids.size, 200);
});
