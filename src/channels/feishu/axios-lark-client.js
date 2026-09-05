'use strict';

/**
 * axios 版 Lark HTTP client（drop-in 替换 @larksuiteoapi/node-sdk 的 new Lark.Client）
 *
 * 背景：本机（内网服务器）出网必须走公司代理，而 Lark SDK v1.60 的 HTTP 传输在该代理下失效
 *      —— GET(chat.list) 被代理返回 411、POST(message.create) 直接挂起，且构造传 httpInstance /
 *      patch defaultHttpInstance / 全局请求拦截器强制 agent 全部无效（SDK 内部取 token 走了外部
 *      够不到的传输路径）。而 raw axios（走代理）稳定可用。故用 axios 复刻仅用到的方法。
 *
 * 只实现代码库实际用到的接口，返回值与字段对齐 Lark SDK（{code,msg,data}）：
 *   im.message.create({ params:{receive_id_type}, data:{receive_id,msg_type,content} }) -> {code,msg,data:{message_id}}
 *   im.message.patch ({ path:{message_id}, data:{content} })                            -> {code,msg,data}
 *   im.chat.list     ({ params:{page_size} })                                           -> {code,msg,data:{items:[{chat_id,name}]}}
 *   im.image.create  ({ data:{image_type,image} })                                      -> {code,msg,data:{image_key}}
 *
 * 与 Lark SDK 行为一致：HTTP 出错或响应 code!==0 时抛异常（现有调用点都靠 try/catch 兜底）。
 */

const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const DEFAULT_DOMAIN = 'https://open.feishu.cn';
const REQUEST_TIMEOUT_MS = 15000;
// 上传走的是文件体，几百 KB 过一道正向代理比一次 JSON 往返慢得多，单独给宽限
const UPLOAD_TIMEOUT_MS = 60000;
const TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000; // 提前 5 分钟刷新

/** 与 feishu-listener.js 的 buildProxyAgent 同款：出网必须走代理的机器上，显式给 axios 一个代理 agent。 */
function buildProxyAgent() {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY;
    if (!proxyUrl) return undefined;
    try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        return new HttpsProxyAgent(proxyUrl);
    } catch (err) {
        console.error('[axios-lark-client] 构造代理 agent 失败，将回退默认出网:', err.message);
        return undefined;
    }
}

// token 缓存：按 appId 存 { token, expireAt }；in-flight 请求去重，避免并发重复取 token
const tokenCache = new Map();
const inflightToken = new Map();

function buildHttp(domain) {
    const agent = buildProxyAgent();
    const cfg = {
        baseURL: domain,
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    };
    if (agent) {
        cfg.httpsAgent = agent;
        cfg.httpAgent = agent;
        cfg.proxy = false; // 用显式 agent，关掉 axios 自带 proxy 解析
    }
    return axios.create(cfg);
}

function larkError(code, msg) {
    const e = new Error(`Feishu API error ${code}: ${msg || 'unknown'}`);
    e.code = code;
    return e;
}

const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
};

/** 流 → Buffer。上传接口只用得到整块内容，而手搓 multipart 也需要先知道长度 */
function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

/**
 * 手搓 multipart/form-data。
 *
 * 不用 axios 自带的 FormData 序列化：它会不会覆盖我们显式设的 Content-Type、boundary 由谁
 * 生成，这些在 axios 各版本间有过变化；而这里只有「几个文本字段 + 一个文件」，手搓十几行
 * 就能让 boundary 与 Content-Length 一定对得上，省掉一个跨版本的不确定性。
 */
function buildMultipart(fields, file) {
    const boundary = `----agentnotifier${crypto.randomBytes(12).toString('hex')}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
            'utf8'
        ));
    }
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}";`
        + ` filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        'utf8'
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function createAxiosLarkClient({ appId, appSecret, domain } = {}) {
    if (!appId || !appSecret) {
        throw new Error('createAxiosLarkClient requires appId and appSecret');
    }
    const base = domain || process.env.FEISHU_DOMAIN || DEFAULT_DOMAIN;
    const http = buildHttp(base);

    async function fetchToken() {
        const resp = await http.post('/open-apis/auth/v3/tenant_access_token/internal', {
            app_id: appId,
            app_secret: appSecret,
        });
        const body = resp.data || {};
        if (body.code !== 0 || !body.tenant_access_token) {
            throw larkError(body.code, body.msg || 'failed to get tenant_access_token');
        }
        const expireMs = (Number(body.expire) || 7200) * 1000;
        tokenCache.set(appId, { token: body.tenant_access_token, expireAt: Date.now() + expireMs });
        return body.tenant_access_token;
    }

    async function getToken() {
        const cached = tokenCache.get(appId);
        if (cached && cached.expireAt - TOKEN_EARLY_REFRESH_MS > Date.now()) {
            return cached.token;
        }
        if (inflightToken.has(appId)) return inflightToken.get(appId);
        const p = fetchToken().finally(() => inflightToken.delete(appId));
        inflightToken.set(appId, p);
        return p;
    }

    /** 统一发起带鉴权的请求，返回 Lark 风格响应体 {code,msg,data}；出错/code!==0 抛异常 */
    async function authed(method, url, { params, data, headers, timeout } = {}) {
        const token = await getToken();
        let resp;
        try {
            resp = await http.request({
                method,
                url,
                params,
                data,
                timeout,
                headers: { Authorization: `Bearer ${token}`, ...headers },
            });
        } catch (err) {
            // 飞书对业务错误常返回 4xx，axios 会先抛；把响应体里的飞书 code/msg 透出来（如 230002）
            const body = err.response && err.response.data;
            if (body && typeof body === 'object' && 'code' in body) {
                throw larkError(body.code, body.msg);
            }
            throw err; // 网络/超时等
        }
        const body = resp.data || {};
        if (body.code !== 0) {
            throw larkError(body.code, body.msg);
        }
        return body;
    }

    return {
        im: {
            message: {
                // POST /open-apis/im/v1/messages?receive_id_type=...
                create({ params, data } = {}) {
                    return authed('post', '/open-apis/im/v1/messages', { params, data });
                },
                // PATCH /open-apis/im/v1/messages/{message_id}
                patch({ path, data } = {}) {
                    const id = path && path.message_id;
                    if (!id) throw new Error('message.patch requires path.message_id');
                    return authed('patch', `/open-apis/im/v1/messages/${encodeURIComponent(id)}`, { data });
                },
            },
            chat: {
                // GET /open-apis/im/v1/chats?page_size=...
                list({ params } = {}) {
                    return authed('get', '/open-apis/im/v1/chats', { params });
                },
            },
            image: {
                // POST /open-apis/im/v1/images —— 拿 image_key 用于卡片里的 ![alt](image_key)
                // data.image 收 Buffer 或 fs.ReadStream（与 Lark SDK 的调用形态一致）
                async create({ data } = {}) {
                    const src = data && data.image;
                    if (!src) throw new Error('image.create requires data.image');
                    const buffer = Buffer.isBuffer(src) ? src : await streamToBuffer(src);
                    // ReadStream 带 path，据它给出真实文件名与 MIME；飞书按内容判类型，
                    // 但给对了能少一层猜测
                    const name = typeof src.path === 'string' ? path.basename(src.path) : 'image.png';
                    const { body, contentType } = buildMultipart(
                        { image_type: (data && data.image_type) || 'message' },
                        {
                            field: 'image',
                            name,
                            type: MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream',
                            buffer,
                        }
                    );
                    return authed('post', '/open-apis/im/v1/images', {
                        data: body,
                        headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
                        timeout: UPLOAD_TIMEOUT_MS,
                    });
                },
            },
        },
    };
}

module.exports = { createAxiosLarkClient, buildProxyAgent, buildMultipart, streamToBuffer };
