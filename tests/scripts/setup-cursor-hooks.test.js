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

function tmpHooksPath(name) {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'an-hooks-')), name);
}

function readHooks(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
}

const EVENTS_OF = (hooks) => Object.keys(hooks).sort();

test('完整模式：阻塞事件与只读事件都在', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install();

    assert.deepEqual(EVENTS_OF(readHooks(file)), [
        'afterAgentResponse', 'afterAgentThought', 'beforeMCPExecution', 'beforeShellExecution',
        'postToolUse', 'postToolUseFailure', 'sessionStart', 'stop', 'subagentStart',
    ]);
});

test('afterAgentThought / subagentStart 必须注册：缺了会把长思考/长子代理误报成卡死', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install({ notifyOnly: true });

    const hooks = readHooks(file);
    assert.ok(hooks.afterAgentThought, '长思考期间靠它刷心跳');
    assert.ok(hooks.subagentStart, '它是「开始干长活」的信号');
});

test('--notify-only：不装 beforeShellExecution/beforeMCPExecution', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install({ notifyOnly: true });

    const hooks = readHooks(file);
    assert.deepEqual(EVENTS_OF(hooks), [
        'afterAgentResponse', 'afterAgentThought', 'postToolUse', 'postToolUseFailure',
        'sessionStart', 'stop', 'subagentStart',
    ]);
    // 远程只读模式下 stop 不等人，超时不该是「续写超时 + 30」那种长值
    assert.equal(hooks.stop[0].timeout, 60);
});

test('sessionStart 必须注册：它是选择题唯一的补救口子', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);
    setup.install();
    assert.ok(readHooks(file).sessionStart[0].command.includes('cursor-hook-handler.js'));
});

test('完整模式 → 只读模式：残留的阻塞事件必须被撤掉', () => {
    const file = tmpHooksPath('hooks.json');
    const setup = loadSetup(file);

    setup.install();
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
