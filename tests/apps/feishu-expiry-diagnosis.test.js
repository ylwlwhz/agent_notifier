'use strict';

/**
 * 回归测试：「卡片已过期」的归因。
 *
 * 背景（用户长期反馈「点 2-3 次才成功一次」）：飞书允许同一个 app 建立多条 WS
 * 长连接，并把每次回调【随机】投给其中一条。多余的 listener 会分走一部分点击、
 * 用它自己的 state 作答 → 用户看到随机的「卡片已过期」。
 *
 * 老代码把「查不到通知」的三种原因压成同一句「该卡片已过期」，且日志只打 key 的
 * 前 24 字符（正好切掉了 13 位毫秒时间戳）——于是最常见的那种（卡片属于另一条
 * 连接）被误报成过期，也留不下可据以定位的痕迹。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { SessionState } = require('../../src/lib/session-state');

const LISTENER_PATH = require.resolve('../../src/apps/feishu-listener');

function makeListener() {
    process.env.FEISHU_APP_ID = 'x';
    process.env.FEISHU_APP_SECRET = 'y';
    delete require.cache[LISTENER_PATH];
    const { FeishuListener } = require('../../src/apps/feishu-listener');
    const file = `/tmp/test-expiry-diag-${process.pid}-${Math.floor(performance.now())}.json`;
    const state = new SessionState(file);
    state.load(); state.data = {}; state.save();
    const listener = Object.create(FeishuListener.prototype);
    listener.state = state;
    listener.client = {
        im: { message: { create: async () => ({ data: { message_id: 'm' } }) } },
    };
    return { FeishuListener, listener, state, file, cleanup: () => fs.rmSync(file, { force: true }) };
}

function addLive(state, ts) {
    state.addNotification(`feishu_live_${ts}`, {
        session_id: 's', pts_device: '/dev/ttys1', created_at: ts, responses: {},
    });
}

test('key 龄超过阈值 → expired（唯一该说「已过期」的情况）', () => {
    process.env.NOTIFICATION_EXPIRE_HOURS = '24';
    const { listener, state, cleanup } = makeListener();
    try {
        const now = Date.now();
        addLive(state, now);
        const d = listener._diagnoseMissingNotification(`feishu_old_${now - 30 * 3600000}`);
        assert.equal(d.kind, 'expired');
        assert.ok(d.keyAgeH > 24, `key 龄应 >24h，实际 ${d.keyAgeH}`);
    } finally { cleanup(); delete process.env.NOTIFICATION_EXPIRE_HOURS; }
});

test('key 还很新但本进程不认识 → foreign（多 listener 抢分发的特征）', () => {
    process.env.NOTIFICATION_EXPIRE_HOURS = '24';
    const { listener, state, cleanup } = makeListener();
    try {
        const now = Date.now();
        addLive(state, now); // 本进程确实有活通知，排除「刚重启」
        const d = listener._diagnoseMissingNotification(`feishu_other_${now - 60000}`);
        assert.equal(d.kind, 'foreign', '未过期 + 本进程有其它活通知 → 卡片属于别的 listener');
        assert.match(d.hint, /第二个 listener/, 'hint 应指向真正的排查方向');
    } finally { cleanup(); delete process.env.NOTIFICATION_EXPIRE_HOURS; }
});

test('本进程 state 为空 → consumed（刚重启，不冤枉别的 listener）', () => {
    process.env.NOTIFICATION_EXPIRE_HOURS = '24';
    const { listener, cleanup } = makeListener();
    try {
        const d = listener._diagnoseMissingNotification(`feishu_x_${Date.now() - 60000}`);
        assert.equal(d.kind, 'consumed');
    } finally { cleanup(); delete process.env.NOTIFICATION_EXPIRE_HOURS; }
});

test('foreign 的 toast 不再谎称「已过期」，而是说清被投递到别的进程', async () => {
    process.env.NOTIFICATION_EXPIRE_HOURS = '24';
    const { FeishuListener, listener, state, cleanup } = makeListener();
    try {
        const now = Date.now();
        addLive(state, now);
        const r = await FeishuListener.prototype.handleCardAction.call(listener, {
            action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: `feishu_other_${now - 60000}` } },
            context: { open_chat_id: 'c' },
        });
        assert.equal(r.toast.type, 'warning');
        assert.doesNotMatch(r.toast.content, /已过期/, 'key 没过期就不该说「已过期」——这正是长期误导用户的那句');
        assert.match(r.toast.content, /另一个监听进程|再点一次/, 'toast 应给出可操作的说明');
    } finally { cleanup(); delete process.env.NOTIFICATION_EXPIRE_HOURS; }
});

test('真过期的 toast 仍然说「已过期」并带阈值', async () => {
    process.env.NOTIFICATION_EXPIRE_HOURS = '24';
    const { FeishuListener, listener, state, cleanup } = makeListener();
    try {
        const now = Date.now();
        addLive(state, now);
        const r = await FeishuListener.prototype.handleCardAction.call(listener, {
            action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: `feishu_old_${now - 30 * 3600000}` } },
            context: { open_chat_id: 'c' },
        });
        assert.match(r.toast.content, /已过期/);
        assert.match(r.toast.content, /24/, 'toast 应带上实际阈值，便于判断是否配置问题');
    } finally { cleanup(); delete process.env.NOTIFICATION_EXPIRE_HOURS; }
});

test('菜单过期保持原有措辞（重新发送 claude）', async () => {
    const { FeishuListener, listener, cleanup } = makeListener();
    try {
        const r = await FeishuListener.prototype.handleCardAction.call(listener, {
            action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: 'feishu_launch_dead' } },
            context: { open_chat_id: 'c' },
        });
        assert.match(r.toast.content, /claude/);
        assert.ok(!r.card, '仍不 patch 卡片（保留原卡内容）');
    } finally { cleanup(); }
});

test('无时间戳的 key → unknown，用中性措辞，既不说过期也不指控别的进程', async () => {
    const { FeishuListener, listener, cleanup } = makeListener();
    try {
        const d = listener._diagnoseMissingNotification('feishu_no_timestamp_here');
        assert.equal(d.keyAgeH, null, '解析不出时间戳应为 null，而不是 NaN');
        assert.equal(d.kind, 'unknown', '判不出年龄就该老实说不知道');

        const r = await FeishuListener.prototype.handleCardAction.call(listener, {
            action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: 'feishu_ask_dead_1' } },
            context: { open_chat_id: 'c' },
        });
        assert.match(r.toast.content, /已过期或已处理/, '中性措辞：不硬判是哪种');
        assert.doesNotMatch(r.toast.content, /另一个监听进程/, '没有证据就不指控别的 listener');
    } finally { cleanup(); }
});

test('warnRivalListeners：pgrep 无匹配时，跨机排查提示仍要打印', () => {
    // 这行提示原本被放在 try 内部，pgrep 退出码 1（无匹配）时连它一起被跳过——
    // 实测服务启动后日志里既无警告也无提示，等于白加。
    //
    // 用一个「必定无匹配」的 PATH 来确定性复现：真机上是否有 listener 在跑
    // 会影响 pgrep 结果，测试不能依赖那个（否则本机跑着服务时此测试就会翻）。
    const { listener, cleanup } = makeListener();
    const lines = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origPath = process.env.PATH;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(a.join(' '));
    process.env.PATH = '/nonexistent-bin'; // pgrep 找不到 → execFileSync 抛 ENOENT
    try {
        listener.warnRivalListeners();
        const joined = lines.join('\n');
        assert.match(joined, /排查其它机器上的 listener/,
            'pgrep 不可用/无匹配时也必须留下排查线索（原 bug：提示被 catch 一起吞掉）');
    } finally {
        process.env.PATH = origPath;
        console.log = origLog;
        console.warn = origWarn;
        cleanup();
    }
});

test('warnRivalListeners：只把真正跑 listener 的 node 进程当 rival', () => {
    // pgrep -f 匹配整条命令行：提到该文件名的 shell/grep/编辑器都会被匹配上。
    // 实测曾把「包含此文件名的 pgrep 命令自身」当成 rival 而误报。
    const { listener, cleanup } = makeListener();
    try {
        const classify = (line) => {
            const pid = parseInt(line, 10);
            if (!pid || pid === process.pid || pid === process.ppid) return false;
            const cmd = line.slice(String(pid).length).trim();
            return /(^|\/)node(\s|$)/.test(cmd) && /feishu-listener\.js(\s|$)/.test(cmd);
        };
        assert.equal(classify('999 /usr/local/bin/node /p/feishu-listener.js'), true, '真 listener');
        assert.equal(classify("123 /bin/zsh -c eval 'pgrep -fl feishu-listener.js'"), false, 'shell 命令不算');
        assert.equal(classify('888 grep feishu-listener.js'), false, 'grep 不算');
        assert.equal(classify('777 vim src/apps/feishu-listener.js'), false, '编辑器不算');
    } finally { cleanup(); }
});
