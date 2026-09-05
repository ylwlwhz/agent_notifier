'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * setup-cursor-hooks 在 require 时就把 hooksPath 定下来了（读 CURSOR_HOOKS），
 * 所以必须先设环境变量再 require。每个用例用独立临时文件，互不干扰。
 */
function loadSetup(hooksPath) {
    process.env.CURSOR_HOOKS = hooksPath;
    const modPath = require.resolve('../../scripts/setup-cursor-hooks');
    delete require.cache[modPath];
    return require(modPath);
}

/**
 * 每个用例一个独立临时目录，跑完统一删掉。
 *
 * 必须删：Linux 的 /tmp 没人清扫，而这个 helper 每调一次就建一个目录 —— 内网机上实测
 * 攒到了 190 个 an-hooks-*（macOS 看不出来，只因为 $TMPDIR 会被系统定期清）。
 * 那是台多人共用的机器，别拿测试垃圾占着它的 /tmp。
 */
const tmpDirs = [];
test.after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpHooksPath(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-hooks-'));
    tmpDirs.push(dir);
    return path.join(dir, name);
}

/** 用环境变量覆盖策略：readEnvTimeouts 里 process.env 优先于 .env，用例因此与真实 .env 无关 */
function withPolicy(vars, fn) {
    const keys = ['CURSOR_REMOTE_APPROVAL', 'CURSOR_REMOTE_FOLLOWUP',
        'CURSOR_FOLLOWUP_TIMEOUT_SEC', 'CURSOR_APPROVAL_TIMEOUT_SEC', 'NOTIFICATION_EXPIRE_HOURS'];
    const saved = {};
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, vars);
    try { return fn(); } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

function readHooks(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
}

const EVENTS_OF = (hooks) => Object.keys(hooks).sort();

test('审批+续写都开：阻塞事件与只读事件都在，stop 用长超时', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    withPolicy({
        CURSOR_REMOTE_APPROVAL: '1', CURSOR_REMOTE_FOLLOWUP: '1',
        CURSOR_FOLLOWUP_TIMEOUT_SEC: '600', NOTIFICATION_EXPIRE_HOURS: '24',
    }, () => setup.install());

    const hooks = readHooks(file);
    assert.deepEqual(EVENTS_OF(hooks), [
        'afterAgentResponse', 'afterAgentThought', 'beforeMCPExecution', 'beforeShellExecution',
        'postToolUse', 'postToolUseFailure', 'sessionStart', 'stop', 'subagentStart',
    ]);
    assert.equal(hooks.stop[0].timeout, 630, 'stop 超时必须比等待上限多留余量');
});

test('审批关着就不注册 beforeShellExecution —— 否则每条命令白付一次 hook 启动', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    withPolicy({ CURSOR_REMOTE_APPROVAL: '0', CURSOR_REMOTE_FOLLOWUP: '1',
        CURSOR_FOLLOWUP_TIMEOUT_SEC: '300', NOTIFICATION_EXPIRE_HOURS: '24' }, () => setup.install());

    const hooks = readHooks(file);
    assert.equal(hooks.beforeShellExecution, undefined);
    assert.equal(hooks.beforeMCPExecution, undefined);
    assert.equal(hooks.stop[0].timeout, 330, '续写开着，stop 仍要用长超时');
});

test('两条阻塞链路都关：stop 只发通知卡，超时给一次 API 往返就够', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    withPolicy({ CURSOR_REMOTE_APPROVAL: '0', CURSOR_REMOTE_FOLLOWUP: '0' }, () => setup.install());

    const hooks = readHooks(file);
    assert.equal(hooks.beforeShellExecution, undefined);
    assert.equal(hooks.stop[0].timeout, 60);
});

test('--notify-only 是显式覆盖：.env 说开也一律退回只读', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    withPolicy({ CURSOR_REMOTE_APPROVAL: '1', CURSOR_REMOTE_FOLLOWUP: '1',
        CURSOR_FOLLOWUP_TIMEOUT_SEC: '600', NOTIFICATION_EXPIRE_HOURS: '24' },
        () => setup.install({ notifyOnly: true }));

    const hooks = readHooks(file);
    assert.equal(hooks.beforeShellExecution, undefined, 'listener 不在本机时阻塞链路没人接');
    assert.equal(hooks.stop[0].timeout, 60);
});

test('afterAgentThought / subagentStart 必须注册：缺了会把长思考/长子代理误报成卡死', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install({ notifyOnly: true });

    const hooks = readHooks(file);
    assert.ok(hooks.afterAgentThought, '长思考期间靠它刷心跳');
    assert.ok(hooks.subagentStart, '它是「开始干长活」的信号');
});

test('--notify-only 的事件集就是那七个只读事件', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install({ notifyOnly: true });

    const hooks = readHooks(file);
    assert.deepEqual(EVENTS_OF(hooks), [
        'afterAgentResponse', 'afterAgentThought', 'postToolUse', 'postToolUseFailure',
        'sessionStart', 'stop', 'subagentStart',
    ]);
    // 只读模式下 stop 不等人，超时不该是「续写超时 + 30」那种长值
    assert.equal(hooks.stop[0].timeout, 60);
});

test('sessionStart 必须注册：它是选择题唯一的补救口子', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install();
    assert.ok(readHooks(file).sessionStart[0].command.includes('cursor-hook-handler.js'));
});

test('策略收紧后残留的阻塞事件必须被撤掉', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);

    withPolicy({ CURSOR_REMOTE_APPROVAL: '1', CURSOR_REMOTE_FOLLOWUP: '1',
        NOTIFICATION_EXPIRE_HOURS: '24' }, () => setup.install());
    assert.ok(readHooks(file).beforeShellExecution);

    setup.install({ notifyOnly: true });
    const hooks = readHooks(file);
    // 少了这一步，远程机上每条命令都会白等一次超时
    assert.equal(hooks.beforeShellExecution, undefined);
    assert.equal(hooks.beforeMCPExecution, undefined);
    assert.ok(hooks.stop, '只读模式仍要发完成卡');
});

test('幂等：反复装不会重复追加条目', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install();
    setup.install();
    setup.install();

    for (const list of Object.values(readHooks(file))) {
        assert.equal(list.length, 1);
    }
});

test('卸载只删本仓库的条目，别人的 hook 原样留下', () => {
    const file = tmpHooksPath('hooks.json');
    fs.writeFileSync(file, JSON.stringify({
        version: 1,
        hooks: { stop: [{ command: '/opt/other/audit.sh', timeout: 5 }] },
    }));

    const setup = loadSetup(file);
    setup.install();
    assert.equal(readHooks(file).stop.length, 2);

    setup.remove();
    const hooks = readHooks(file);
    assert.deepEqual(hooks.stop, [{ command: '/opt/other/audit.sh', timeout: 5 }]);
    assert.equal(hooks.sessionStart, undefined, '空数组不该留下空壳');
});
