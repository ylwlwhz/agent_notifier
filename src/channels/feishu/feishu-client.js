'use strict';

const { createAxiosLarkClient } = require('./axios-lark-client');

/**
 * 建一个「能发飞书 HTTP 请求」的 client。
 *
 * 两种传输，按机器所处的出网环境选：
 *   - 默认走 Lark SDK（多数机器可直连飞书，SDK 功能最全）
 *   - FEISHU_FORCE_PROXY=1 的机器走 axios shim：这类机器出网必须经公司正向代理，
 *     而 SDK v1.60 的传输层在该代理下失效（GET 被返 411、POST 直接挂起，且构造传
 *     httpInstance / 全局拦截器都无效，SDK 内部取 token 走了外部够不到的路径）。
 *     shim 用显式 HttpsProxyAgent + proxy:false 绕开这些，详见 axios-lark-client.js。
 *
 * 所有需要发卡的进程都必须走这里，别再各自 `new Lark.Client` —— 那样在需要代理的机器上
 * 会静默挂住（症状：hook 打完 `client ready` 就再无输出，最后被 hook 超时杀掉）。
 */
function createLarkHttpClient({ appId, appSecret }) {
    if (!appId || !appSecret) {
        throw new Error('createLarkHttpClient requires appId and appSecret');
    }
    const forceProxy = ['1', 'true', 'yes'].includes(
        String(process.env.FEISHU_FORCE_PROXY || '').trim().toLowerCase()
    );
    if (forceProxy) return createAxiosLarkClient({ appId, appSecret });

    // 惰性 require：Lark SDK 是重依赖（网络文件系统上实测 require 要 12.6s，而 shim 只要
    // 5.8s）。走 shim 的机器不该为一个用不到的 SDK 付这笔钱 —— hook 是每个事件起一次的
    // 短命进程，模块加载时间就是用户在 IDE 里干等的时间。
    const Lark = require('@larksuiteoapi/node-sdk');
    return new Lark.Client({ appId, appSecret });
}

function createFeishuClient({ appId, appSecret }) {
    if (!appId || !appSecret) {
        throw new Error('createFeishuClient requires appId and appSecret');
    }

    const client = createLarkHttpClient({ appId, appSecret });

    return {
        client,
        async sendCard({ chatId, card }) {
            if (!chatId) {
                throw new Error('sendCard requires chatId');
            }

            if (!card) {
                throw new Error('sendCard requires card');
            }

            return client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'interactive',
                    content: JSON.stringify(card),
                },
            });
        },
        async patchCard({ messageId, card }) {
            if (!messageId) {
                throw new Error('patchCard requires messageId');
            }

            if (!card) {
                throw new Error('patchCard requires card');
            }

            return client.im.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(card) },
            });
        },
    };
}

module.exports = { createFeishuClient, createLarkHttpClient };
