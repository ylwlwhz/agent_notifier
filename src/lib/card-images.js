'use strict';

/**
 * agent 正文里的 markdown 图片 → 飞书卡片能接受的形态。
 *
 * 踩过的坑（GY_2，2026-09-05，已发生 3 次）：飞书卡片的 `tag: markdown` 会把
 * `![alt](src)` 当成**图片语法**解析，而括号里必须是飞书自己的 image_key。agent 写的是
 * 本机路径（`![动作箭头端到端验证](/root/eh/arrow_live_ep2_f300.png)`），于是整张卡被拒收：
 *
 *   Feishu API error 230099: Failed to create card content,
 *   ext=ErrCode: 200570; ErrMsg: card contains invalid image keys;
 *   ErrorValue: image key /root/eh/arrow_live_ep2_f300.png
 *
 * 后果不是「图没显示」，而是**整张完成卡发不出去** —— 而完成卡是人在外面继续这轮对话的
 * 唯一入口，丢了它就等于失联（当时的表现：有摘要卡、没有完成卡）。
 *
 * 两层处理：
 *   embedImages()  hook 就跑在图片所在那台机器上，把文件上传到飞书换成 image_key，
 *                  手机上直接看得到图。需要应用有 im:resource:upload 权限。
 *   stripImages()  兜底：任何拿不到 image_key 的图片引用都退化成纯文本，绝不留 `![]()`。
 *                  它被挂在 parseMarkdownToElements 里，对**所有宿主的所有卡片**生效
 *                  —— 看不到图是遗憾，收不到卡是故障，这一层保证故障不会发生。
 */

const fs = require('fs');
const path = require('path');

// `![alt](src)`。src 不允许空白与右括号，否则会把后面的正文一起吞掉
const IMAGE_MD = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

// 飞书的图片标识一律 img_ 开头（img_v2_ / img_v3_ …）。这种是已经换好的，要原样留下
const IMAGE_KEY = /^img_[A-Za-z0-9_-]+$/;

const UPLOADABLE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// 飞书单图上限 10MB
const MAX_BYTES = 10 * 1024 * 1024;
// 一张卡最多上传这么多张：hook 是阻塞进程，上传串行做，正文里贴一屏图不该让人干等
const MAX_IMAGES = 5;

function isHttpUrl(src) {
    return /^https?:\/\//i.test(src);
}

/** 图片引用的纯文本形态。**不能再含 `![]()`**，否则飞书照样按图片键去校验 */
function textRef(alt, src, reason = '') {
    const label = String(alt || '').trim() || '图片';
    const why = reason ? `，${reason}` : '';
    return `🖼 **${label}** \`${src}\`${why}`;
}

/**
 * 本地图片路径 → { file } 或 { reason }。
 * 判不了就给出原因：它会写在卡上，比默默少一张图容易排查得多。
 */
function resolveLocal(src, cwd) {
    let raw = src;
    if (raw.startsWith('file://')) raw = raw.slice('file://'.length);
    try { raw = decodeURIComponent(raw); } catch { /* 不是 percent-encoding，原样用 */ }

    const file = path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw);
    if (!UPLOADABLE_EXT.has(path.extname(file).toLowerCase())) {
        return { reason: '不是飞书支持的图片格式' };
    }
    let stat;
    try { stat = fs.statSync(file); } catch { return { reason: '文件不存在' }; }
    if (!stat.isFile()) return { reason: '不是文件' };
    if (stat.size > MAX_BYTES) return { reason: `超过 10MB（${Math.round(stat.size / 1048576)}MB）` };
    return { file };
}

/**
 * 正文里有没有「值得上传」的本机图片。
 *
 * 给调用方省钱用：上传要先把飞书传输层 require 起来（网络文件系统上实测 6s），
 * 而绝大多数正文根本没有图片，不该为此付这笔钱。
 */
function hasLocalImages(text) {
    for (const [, , src] of String(text == null ? '' : text).matchAll(IMAGE_MD)) {
        if (IMAGE_KEY.test(src) || isHttpUrl(src)) continue;
        return true;
    }
    return false;
}

/**
 * 把所有图片引用退化成纯文本（同步，不联网）。
 * 已是 image_key 的保留；http(s) 的转成普通链接（飞书支持链接，但不支持远程图片地址）。
 */
function stripImages(text) {
    return String(text == null ? '' : text).replace(IMAGE_MD, (whole, alt, src) => {
        if (IMAGE_KEY.test(src)) return whole;
        if (isHttpUrl(src)) return `[${String(alt || '').trim() || '图片'}](${src})`;
        return textRef(alt, src);
    });
}

/**
 * 上传本地图片并把正文里的路径换成 image_key；换不了的退化成纯文本。
 *
 * 永不抛异常：这条链路上任何一次失败都不该拖垮发卡。没有 client、没权限、文件没了，
 * 结果都只是「这张图变成一行文字」。
 */
async function embedImages(text, { client, cwd, log } = {}) {
    const raw = String(text == null ? '' : text);
    const refs = [...raw.matchAll(IMAGE_MD)];
    if (!refs.length) return { text: raw, uploaded: 0, degraded: 0 };

    const note = typeof log === 'function' ? log : () => {};
    const canUpload = typeof client?.im?.image?.create === 'function';

    // 同一张图常在正文里被引用多次；按解析出的绝对路径去重，只上传一次
    const resolved = new Map();   // src → { key } | { reason }
    let uploaded = 0;
    let degraded = 0;
    let budget = MAX_IMAGES;

    for (const [, , src] of refs) {
        if (resolved.has(src) || IMAGE_KEY.test(src) || isHttpUrl(src)) continue;

        const local = resolveLocal(src, cwd);
        if (!local.file) { resolved.set(src, local); degraded++; continue; }
        if (!canUpload) { resolved.set(src, { reason: '飞书未开通图片上传' }); degraded++; continue; }
        if (budget <= 0) { resolved.set(src, { reason: `单卡最多上传 ${MAX_IMAGES} 张` }); degraded++; continue; }

        // 同一个文件被不同写法引用（相对/绝对路径）时复用已上传的 key
        const already = [...resolved.values()].find((v) => v.file === local.file && v.key);
        if (already) { resolved.set(src, already); continue; }

        // 传流而不是 Buffer：这是 Lark SDK 的原生形态（axios shim 会自己读成 Buffer）。
        // 但必须挂 error 监听并在失败后 destroy —— 上传在读到内容之前就报错时，
        // 这个流会悬着：既漏一个 fd，还会在事后抛出没人接的 'error'
        const stream = fs.createReadStream(local.file);
        stream.on('error', (err) => note(`读取图片失败 ${local.file}: ${err.message}`));
        try {
            const resp = await client.im.image.create({
                data: { image_type: 'message', image: stream },
            });
            // 两种响应形状都要认：axios shim 回 Lark 风格的 {code,msg,data:{image_key}}，
            // 而 Lark SDK 对【上传类】接口回的是不包 data 的裸对象 {image_key}
            // （实测：同一个 SDK 的 chat.list 回 {code,data,msg}，image.create 只回 {image_key}）。
            // 只认一种的后果是上传明明成功却取不到 key，然后静默退化成文本 —— 极难发现
            const key = resp?.data?.image_key || resp?.image_key;
            if (!key) throw new Error('响应里没有 image_key');
            resolved.set(src, { key, file: local.file });
            uploaded++;
            budget--;
        } catch (err) {
            stream.destroy();
            // 权限没开是最常见的一种，如实写在卡上，省得对着「图没了」猜
            const reason = /99991672|Access denied|scopes is required/i.test(err.message)
                ? '飞书应用缺 im:resource:upload 权限'
                : `上传失败（${err.message.slice(0, 60)}）`;
            resolved.set(src, { file: local.file, reason });
            degraded++;
            note(`图片上传失败 ${local.file}: ${err.message}`);
        }
    }

    const out = raw.replace(IMAGE_MD, (whole, alt, src) => {
        if (IMAGE_KEY.test(src)) return whole;
        if (isHttpUrl(src)) return `[${String(alt || '').trim() || '图片'}](${src})`;
        const hit = resolved.get(src);
        if (hit?.key) return `![${String(alt || '').trim() || '图片'}](${hit.key})`;
        return textRef(alt, src, hit?.reason || '');
    });

    return { text: out, uploaded, degraded };
}

/**
 * 正文 → 惰性纯文本，给「卡片被飞书拒收后退化重发」那一次用。
 *
 * 拒收的原因不止图片一种（超长、未知标记…），重发时把 markdown 标记整体拿掉，
 * 让正文变成飞书不可能挑刺的形态 —— 排版难看，但交互组件保住了。
 */
function toPlainText(text) {
    return stripImages(text)
        .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '• ')
        .replace(/\*\*|__|~~|`/g, '')
        .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '$1 ($2)');
}

module.exports = {
    embedImages,
    hasLocalImages,
    stripImages,
    toPlainText,
    resolveLocal,
    textRef,
    IMAGE_MD,
    IMAGE_KEY,
    MAX_IMAGES,
    MAX_BYTES,
};
