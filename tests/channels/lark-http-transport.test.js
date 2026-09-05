'use strict';

/**
 * 发卡传输层的选择。
 *
 * 需要代理的机器上（FEISHU_FORCE_PROXY=1），Lark SDK v1.60 的传输层会【静默挂住】——
 * 症状是 hook 打完 `client ready` 就再无输出，最后被 hook 超时杀掉。所以那类机器必须换成
 * axios shim。这里钉住「选择逻辑」本身，以及「所有发卡入口都走工厂」这条纪律。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLarkHttpClient } = require('../../src/channels/feishu/feishu-client');

const CREDS = { appId: 'cli_test', appSecret: 'secret_test' };

function withForceProxy(value, fn) {
    const saved = process.env.FEISHU_FORCE_PROXY;
    if (value === undefined) delete process.env.FEISHU_FORCE_PROXY;
    else process.env.FEISHU_FORCE_PROXY = value;
    try { return fn(); } finally {
        if (saved === undefined) delete process.env.FEISHU_FORCE_PROXY;
        else process.env.FEISHU_FORCE_PROXY = saved;
    }
}

test('默认用 Lark SDK；FEISHU_FORCE_PROXY=1 换成 axios shim', () => {
    const sdk = withForceProxy(undefined, () => createLarkHttpClient(CREDS));
    const shim = withForceProxy('1', () => createLarkHttpClient(CREDS));

    // SDK 的 client 有大量命名空间，shim 只实现用到的 im.*
    assert.ok(sdk.im.message.create);
    assert.ok(shim.im.message.create);
    assert.notEqual(Object.keys(sdk).length, Object.keys(shim).length);
    assert.deepEqual(Object.keys(shim), ['im']);
});

test('shim 覆盖了代码库实际用到的方法', () => {
    const shim = withForceProxy('1', () => createLarkHttpClient(CREDS));
    assert.equal(typeof shim.im.message.create, 'function');
    assert.equal(typeof shim.im.message.patch, 'function'); // 卡片收敛 / live patch
    assert.equal(typeof shim.im.chat.list, 'function');     // resolve-chat-id 兜底找群
    // 正文里的本机图片要传上去换 image_key，否则整张卡会被飞书拒收（见 card-images.js）。
    // SDK 原生就有 im.image.create，shim 得自己补 —— 漏了它，必须走代理的机器上图片全丢
    assert.equal(typeof shim.im.image.create, 'function');
});

// ── 上传用的 multipart：手搓的，boundary 与长度必须自洽 ──────────────────────

const { buildMultipart, streamToBuffer } = require('../../src/channels/feishu/axios-lark-client');

test('multipart 的 boundary、字段与结束标记自洽', () => {
    const { body, contentType } = buildMultipart(
        { image_type: 'message' },
        { field: 'image', name: 'a.png', type: 'image/png', buffer: Buffer.from([1, 2, 3]) }
    );
    const boundary = /boundary=(.+)$/.exec(contentType)[1];
    const text = body.toString('latin1');

    assert.match(text, new RegExp(`^--${boundary}\r\n`), '必须以 boundary 开头');
    assert.ok(text.endsWith(`\r\n--${boundary}--\r\n`), '缺结束标记飞书会判为不完整请求');
    assert.match(text, /name="image_type"\r\n\r\nmessage\r\n/);
    assert.match(text, /name="image"; filename="a.png"\r\nContent-Type: image\/png/);
    // 二进制原样嵌入，不能被当字符串转码
    assert.ok(body.includes(Buffer.from([1, 2, 3])));
});

test('streamToBuffer 读得出完整内容（shim 拿到的是流，要先读成 Buffer 才知道长度）', async () => {
    const file = path.join(os.tmpdir(), `an-mp-${process.pid}.bin`);
    fs.writeFileSync(file, Buffer.from([9, 8, 7, 6]));
    try {
        assert.deepEqual([...await streamToBuffer(fs.createReadStream(file))], [9, 8, 7, 6]);
    } finally {
        try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    }
});

test('缺凭据时明确报错，不返回一个用不了的 client', () => {
    assert.throws(() => createLarkHttpClient({ appId: 'x' }), /requires appId and appSecret/);
    assert.throws(() => createLarkHttpClient({}), /requires appId and appSecret/);
});

/** 去掉注释行，只留真正的代码——注释里提到 new Lark.Client 是允许的（就是在讲这件事） */
function codeOnly(src) {
    return src.split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n');
}

test('Cursor 的发卡入口一律走工厂，不得直接 new Lark.Client', () => {
    // 这条纪律没有单测就会悄悄退化：任何一处漏掉，那台必须走代理的机器就再次静默挂死
    const root = path.join(__dirname, '..', '..', 'src', 'apps');
    for (const file of ['cursor-hook.js', 'cursor-live.js', 'cursor-stall-watch.js']) {
        const src = fs.readFileSync(path.join(root, file), 'utf8');
        assert.doesNotMatch(codeOnly(src), /new Lark\.Client/, file);
        assert.match(src, /createLarkHttpClient/, file);
    }
});

// ── 纯通知卡走 detached 发送 ─────────────────────────────────────────────────

const cursorHook = require('../../src/apps/cursor-hook');
const { sendCardFile } = require('../../src/apps/cursor-send-card');

function withoutCreds(fn) {
    const saved = { id: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET };
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    try { return fn(); } finally {
        if (saved.id) process.env.FEISHU_APP_ID = saved.id;
        if (saved.secret) process.env.FEISHU_APP_SECRET = saved.secret;
    }
}

test('没配凭据时 sendCardDetached 直接返回 false，不 spawn 任何东西', () => {
    withoutCreds(() => {
        assert.equal(cursorHook.sendCardDetached({ body: { elements: [] } }), false);
    });
});

test('子进程侧：文件缺失或没凭据都安静失败并留痕，不抛异常', async () => {
    // 改写日志路径：往真实的 cursor-send-card-error.log 里写测试垃圾，
    // 会把它事后排查「卡为什么没发出来」的价值冲掉
    const log = path.join(os.tmpdir(), `send-card-test-${process.pid}.log`);
    const saved = process.env.CURSOR_SEND_CARD_LOG;
    process.env.CURSOR_SEND_CARD_LOG = log;
    try {
        assert.equal(await sendCardFile('/tmp/definitely-not-here-8f3a.json'), false);
        assert.equal(await sendCardFile(''), false);
        assert.match(fs.readFileSync(log, 'utf8'), /读取卡片文件失败/);
    } finally {
        if (saved === undefined) delete process.env.CURSOR_SEND_CARD_LOG;
        else process.env.CURSOR_SEND_CARD_LOG = saved;
        try { fs.unlinkSync(log); } catch { /* 忽略 */ }
    }
});
