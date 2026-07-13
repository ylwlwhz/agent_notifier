'use strict';

const { createAxiosLarkClient } = require('./axios-lark-client');

function createFeishuClient({ appId, appSecret }) {
    if (!appId || !appSecret) {
        throw new Error('createFeishuClient requires appId and appSecret');
    }

    // 用 axios 版 shim 替代 Lark SDK 的 HTTP client（SDK 传输层在强制代理下失效，见 axios-lark-client.js）
    const client = createAxiosLarkClient({ appId, appSecret });

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

module.exports = { createFeishuClient };
