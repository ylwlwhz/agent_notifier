'use strict';

/**
 * 会话归属过滤。
 *
 * 这不是降噪功能而是隐私边界：共享 root 的机器上 hooks.json / mcp.json 都是用户级的，
 * 同事的会话会走进本仓库（GY_2 实测：/tmp 里留下了同事会话的标记，5 个 MCP 进程里
 * 4 个是同事的窗口）。所以这里钉死两件事——该拦的必须拦住，以及拦不准时往哪边倒。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCursorControlConfig, isOwnSession, underRoot } = require('../../../src/adapters/cursor/control-policy');

const MINE = '/apdcephfs_private/qy/projects/whz';
const config = (env) => parseCursorControlConfig(env);
const event = (workspaceRoot, userEmail = '') => ({ meta: { workspaceRoot, userEmail } });

test('两道都不配就不过滤：单人机器不该被逼着写配置', () => {
    const c = config({});
    assert.deepEqual(c.owner, { roots: [], users: [] });
    assert.equal(isOwnSession(c, event('/anyone/else/project', 'someone@else.com')), true);
});

test('路径白名单：自己目录放行，同事目录拦掉', () => {
    const c = config({ CURSOR_NOTIFY_ROOTS: MINE });

    assert.equal(isOwnSession(c, event(MINE)), true, '白名单本身就该算在内');
    assert.equal(isOwnSession(c, event(`${MINE}/agent_notifier`)), true);
    assert.equal(isOwnSession(c, event(`${MINE}/EmbodiedHub`)), true);
    assert.equal(isOwnSession(c, event('/apdcephfs_private/qy/projects/wjj/starVLA')), false,
        '同事的工作区必须拦住 —— 这就是 GY_2 上真实漏出去的那条');
});

test('前缀匹配要带边界：whz 不该把 whz-backup 一起放进来', () => {
    const c = config({ CURSOR_NOTIFY_ROOTS: MINE });
    assert.equal(isOwnSession(c, event(`${MINE}-backup/x`)), false);
    assert.equal(underRoot(`${MINE}-backup`, MINE), false);
    assert.equal(underRoot(`${MINE}/x`, MINE), true);
});

test('多个前缀、末尾斜杠、空项都要能容忍', () => {
    const c = config({ CURSOR_NOTIFY_ROOTS: `${MINE}/, , /root/projects` });
    assert.equal(c.owner.roots.length, 2);
    assert.equal(isOwnSession(c, event(`${MINE}/calib-viz`)), true);
    assert.equal(isOwnSession(c, event('/root/projects/MLLM-scaling')), true);
    assert.equal(isOwnSession(c, event('/root/other')), false);
});

test('配了路径白名单却认不出工作区 → 不发（宁可漏卡，不能漏别人的内容）', () => {
    const c = config({ CURSOR_NOTIFY_ROOTS: MINE });
    assert.equal(isOwnSession(c, event('')), false);
    assert.equal(isOwnSession(c, { meta: {} }), false);
});

test('账号白名单：认人不认路，同事开我的目录也拦得住', () => {
    const c = config({ CURSOR_NOTIFY_USERS: 'Me@Example.com' });

    assert.equal(isOwnSession(c, event('/anywhere', 'me@example.com')), true, '大小写不该影响判定');
    assert.equal(isOwnSession(c, event(MINE, 'wjj@example.com')), false,
        '路径是我的、但驱动会话的是别人的账号');
});

test('payload 不带 user_email 时不作判断：硬判会把自己的通知也静默掐掉', () => {
    const c = config({ CURSOR_NOTIFY_USERS: 'me@example.com' });
    assert.equal(isOwnSession(c, event('/anywhere', '')), true);
});

test('双保险：两道各自独立生效，任一条不过就拦', () => {
    const c = config({ CURSOR_NOTIFY_ROOTS: MINE, CURSOR_NOTIFY_USERS: 'me@example.com' });

    assert.equal(isOwnSession(c, event(`${MINE}/agent_notifier`, 'me@example.com')), true);
    assert.equal(isOwnSession(c, event(`${MINE}/agent_notifier`, 'wjj@example.com')), false, '账号不对');
    assert.equal(isOwnSession(c, event('/apdcephfs_private/qy/projects/wjj/starVLA', 'me@example.com')), false,
        '路径不对（我去别人目录里干活，也不该把卡发到这个会话上）');
    // 账号字段缺失时仍由路径兜住 —— 这是老版本 cursor-server 上的实际形态
    assert.equal(isOwnSession(c, event(`${MINE}/agent_notifier`, '')), true);
    assert.equal(isOwnSession(c, event('/apdcephfs_private/qy/projects/wjj/starVLA', '')), false);
});
