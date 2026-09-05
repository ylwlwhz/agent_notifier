'use strict';

/**
 * 卡片图片处理。
 *
 * 这组用例守的是一次真实故障（GY_2，2026-09-05，连续 3 次）：agent 正文里一句
 * `![动作箭头端到端验证](/root/eh/arrow_live_ep2_f300.png)` 让【整张完成卡】被飞书拒收
 * （230099 / card contains invalid image keys），而完成卡是人在外面继续这轮对话的唯一
 * 入口 —— 症状是「有摘要卡、没有完成卡」，且不留任何 state 痕迹，极难定位。
 *
 * 所以最要紧的一条断言是：**任何拿不到 image_key 的图片引用都不能带着 `![]()` 出卡**。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const images = require('../../src/lib/card-images');
const { parseMarkdownToElements } = require('../../src/lib/feishu-card-utils');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'an-card-img-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 造一个真实存在的小 png */
function makePng(name = 'a.png', bytes = 64) {
    const file = path.join(TMP, name);
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    return file;
}

/**
 * 假飞书 client：记录上传次数，可指定返回 key 或抛错。
 *
 * 刻意【真的把流读完】——两个真实 client（Lark SDK / axios shim）都会读，
 * 假的不读就会留下悬着的流，把「生产代码有没有处理好流」这个问题从用例里藏掉。
 */
function fakeClient({ key = 'img_v3_fake_key', error = null, wrapped = true } = {}) {
    const uploads = [];
    return {
        uploads,
        im: {
            image: {
                create: async ({ data }) => {
                    uploads.push(data.image.path);
                    if (error) { data.image.destroy(); throw error; }
                    await new Promise((resolve, reject) => {
                        data.image.on('end', resolve);
                        data.image.on('error', reject);
                        data.image.resume();
                    });
                    return wrapped ? { code: 0, msg: 'ok', data: { image_key: key } } : { image_key: key };
                },
            },
        },
    };
}

// ── stripImages：兜底层 ──────────────────────────────────────────────────────

test('本机路径的图片引用必须退化成纯文本，绝不能留 ![]( ) 出卡', () => {
    const out = images.stripImages('看这个\n\n![动作箭头](/root/eh/arrow.png)\n\n就是它');
    assert.doesNotMatch(out, /!\[/, '留着图片语法飞书就会去校验 image key，整张卡被拒');
    assert.match(out, /动作箭头/, '图说要留着，否则读的人不知道那是什么');
    assert.match(out, /\/root\/eh\/arrow\.png/, '路径要留着，人在电脑前能照它去看原图');
});

test('已经是 image_key 的原样保留 —— 否则上传完又被自己清掉', () => {
    const out = images.stripImages('![图](img_v3_abcdef_123-x)');
    assert.equal(out, '![图](img_v3_abcdef_123-x)');
});

test('http 图片转成普通链接：飞书的图片语法只认自己的 key，不认远程地址', () => {
    const out = images.stripImages('![封面](https://example.com/a.png)');
    assert.equal(out, '[封面](https://example.com/a.png)');
});

test('图说为空时给个占位名，别渲染成空链接', () => {
    assert.match(images.stripImages('![](/tmp/x.png)'), /图片/);
});

test('src 里不含空白/右括号：不能把后面的正文一起吞掉', () => {
    const out = images.stripImages('![a](/tmp/x.png) 后面还有话(带括号)');
    assert.match(out, /后面还有话\(带括号\)/);
});

// ── 唯一入口上的兜底：所有宿主的所有卡片都过这里 ──────────────────────────────

test('parseMarkdownToElements 是唯一入口，出来的元素里不该有任何本机图片语法', () => {
    const els = parseMarkdownToElements('结论如下\n\n![普查](/root/eh/calib_viz/agibot/census.png)\n');
    const json = JSON.stringify(els);
    assert.doesNotMatch(json, /!\\?\[/, '这一层漏了，三个宿主的卡片都可能被拒收');
    assert.match(json, /census\.png/);
});

test('兜底分支（正文只有空行）也要用清洗过的文本', () => {
    // elements 为空时会退回「整段原文」那条分支，早期版本在这里漏用了原始 content
    const els = parseMarkdownToElements('\n\n');
    assert.doesNotMatch(JSON.stringify(els), /!\[/);
});

// ── hasLocalImages：决定要不要为上传付传输层加载的代价 ────────────────────────

test('hasLocalImages 只对「值得上传的本机图片」为真', () => {
    assert.equal(images.hasLocalImages('![a](/tmp/x.png)'), true);
    assert.equal(images.hasLocalImages('![a](img_v3_x)'), false, '已换好的不用再传');
    assert.equal(images.hasLocalImages('![a](https://e.com/x.png)'), false);
    assert.equal(images.hasLocalImages('没有图'), false);
    assert.equal(images.hasLocalImages(''), false);
});

// ── resolveLocal：判不了要给出原因，写在卡上比默默少张图好排查 ────────────────

test('resolveLocal 对各种不可上传情形给出可读原因', () => {
    assert.equal(images.resolveLocal(makePng('ok.png'), TMP).file, path.join(TMP, 'ok.png'));
    assert.match(images.resolveLocal('/tmp/definitely-missing-9a1c.png', TMP).reason, /不存在/);
    assert.match(images.resolveLocal('/tmp/a.txt', TMP).reason, /格式/);

    const big = path.join(TMP, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(images.MAX_BYTES + 1));
    assert.match(images.resolveLocal(big, TMP).reason, /10MB/);
});

test('相对路径按传入的工作区根解析 —— hook 的 cwd 未必是工作区根', () => {
    makePng('rel.png');
    assert.equal(images.resolveLocal('rel.png', TMP).file, path.join(TMP, 'rel.png'));
});

// ── embedImages：真正让图显示出来 ────────────────────────────────────────────

test('上传成功后正文里换成 image_key，图在手机上就能看到', async () => {
    const file = makePng('up.png');
    const client = fakeClient({ key: 'img_v3_real' });
    const { text, uploaded, degraded } = await images.embedImages(`![箭头](${file})`, { client, cwd: TMP });

    assert.equal(text, '![箭头](img_v3_real)');
    assert.deepEqual([uploaded, degraded], [1, 0]);
    assert.deepEqual(client.uploads, [file]);
});

test('两种响应形状都要认：SDK 对上传接口回的是不包 data 的裸对象', async () => {
    // 实测：同一个 Lark SDK，chat.list 回 {code,data,msg}，而 image.create 只回 {image_key}；
    // axios shim 回的是 Lark 风格的 {code,msg,data:{image_key}}。
    // 只认一种的后果是上传成功却取不到 key，然后静默退化成文本 —— 卡照常发，图莫名没了
    const file = makePng('shape.png');
    for (const wrapped of [true, false]) {
        const { text, uploaded } = await images.embedImages(`![图](${file})`, {
            client: fakeClient({ key: 'img_v3_shape', wrapped }), cwd: TMP,
        });
        assert.equal(text, '![图](img_v3_shape)', `wrapped=${wrapped} 时取不到 key`);
        assert.equal(uploaded, 1);
    }
});

test('同一张图被引用多次只上传一次', async () => {
    const file = makePng('dup.png');
    const client = fakeClient();
    const { text } = await images.embedImages(`![a](${file})\n![b](${file})`, { client, cwd: TMP });

    assert.equal(client.uploads.length, 1);
    assert.equal(text.match(/img_v3_fake_key/g).length, 2);
});

test('缺权限时退化成文本，并把「缺哪个权限」写在卡上', async () => {
    const file = makePng('noperm.png');
    const err = new Error('Feishu API error 99991672: Access denied. One of the following '
        + 'scopes is required: [im:resource:upload, im:resource]');
    const { text, uploaded, degraded } = await images.embedImages(`![图](${file})`, {
        client: fakeClient({ error: err }), cwd: TMP,
    });

    assert.doesNotMatch(text, /!\[/, '退化后绝不能再留图片语法');
    assert.match(text, /im:resource:upload/, '缺权限要明说，否则只能对着「图没了」猜');
    assert.deepEqual([uploaded, degraded], [0, 1]);
});

test('上传报别的错也只是退化，不能把发卡拖垮', async () => {
    const file = makePng('boom.png');
    const { text, degraded } = await images.embedImages(`![图](${file})`, {
        client: fakeClient({ error: new Error('socket hang up') }), cwd: TMP,
    });
    assert.match(text, /上传失败/);
    assert.doesNotMatch(text, /!\[/);
    assert.equal(degraded, 1);
});

test('client 不支持上传（或压根没有）时安静退化', async () => {
    const file = makePng('noclient.png');
    for (const client of [undefined, {}, { im: {} }]) {
        const { text, degraded } = await images.embedImages(`![图](${file})`, { client, cwd: TMP });
        assert.doesNotMatch(text, /!\[/);
        assert.equal(degraded, 1);
    }
});

test('单卡上传张数有上限：hook 是阻塞进程，不能为一屏图让人干等', async () => {
    const files = [];
    for (let i = 0; i <= images.MAX_IMAGES; i++) files.push(makePng(`m${i}.png`));
    const client = fakeClient();
    const { text, uploaded, degraded } = await images.embedImages(
        files.map((f, i) => `![图${i}](${f})`).join('\n'), { client, cwd: TMP }
    );

    assert.equal(uploaded, images.MAX_IMAGES);
    assert.equal(degraded, 1);
    assert.equal(client.uploads.length, images.MAX_IMAGES);
    assert.match(text, new RegExp(`最多上传 ${images.MAX_IMAGES} 张`));
});

test('没有图片时不碰 client，也不产生任何 I/O（绝大多数正文走这条快路径）', async () => {
    const client = fakeClient();
    const { text, uploaded, degraded } = await images.embedImages('就是一段普通正文', { client });
    assert.equal(text, '就是一段普通正文');
    assert.deepEqual([uploaded, degraded, client.uploads.length], [0, 0, 0]);
});

// ── toPlainText：卡片被拒后退化重发用的形态 ──────────────────────────────────

test('toPlainText 把正文压成飞书挑不出刺的纯文本，但信息还在', () => {
    const out = images.toPlainText(
        '# 标题\n**粗体** 与 `代码`\n- 项一\n> 引用\n[链接](https://e.com)\n![图](/tmp/x.png)'
    );
    assert.doesNotMatch(out, /[*`#>]/);
    assert.doesNotMatch(out, /!\[/);
    assert.match(out, /标题/);
    assert.match(out, /• 项一/);
    assert.match(out, /链接 \(https:\/\/e\.com\)/);
});
