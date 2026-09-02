/**
 * 发一张「不需要等结果」的卡（detached 子进程）。
 *
 * 为什么要单独起个进程：hook 是阻塞式的，它没返回，Cursor 就一直等。而纯通知卡
 * （完成卡）发出去之后没人再看它的 message_id —— 让 hook 同步等一次飞书往返
 * 纯属让用户在 IDE 里干等。
 *
 * 这笔开销在网络文件系统上尤其贵：远程机（CephFS）实测 require 一次飞书传输层要 6s，
 * 加上鉴权与发卡，同步发完整张卡要 10s；改成 detached 之后 hook 只剩 ~2s。
 *
 * 反过来，审批卡与「等续写」的完成卡【不能】走这里：它们发完还要用 message_id 把卡片
 * 收敛成只读态，必须留在 hook 进程里同步发。
 *
 * 用法：node cursor-send-card.js <card.json 的路径>
 */

'use strict';

const fs = require('fs');
const { sharedTmpPath } = require('../lib/tmp-dir');

// 失败必须留痕：stdio 是 ignore 的，console 输出会直接消失，
// 而「卡没发出来」正是事后最难查的一类问题。
// 路径可被环境变量改写 —— 测试往真实日志里写垃圾会把它的诊断价值冲掉。
function errorLogPath() {
    return process.env.CURSOR_SEND_CARD_LOG || sharedTmpPath('cursor-send-card-error.log');
}

function logFailure(message) {
    try {
        fs.appendFileSync(errorLogPath(), `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch { /* 连日志都写不了就算了，不能再抛 */ }
}

async function sendCardFile(file) {
    if (!file) return false;

    let card;
    try {
        card = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        logFailure(`读取卡片文件失败 ${file}: ${err.message}`);
        return false;
    }
    // 读到就删：这张卡只该发一次，重试留给下一个事件
    try { fs.unlinkSync(file); } catch { /* 已被清理 */ }

    require('../lib/env-config');
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
        logFailure('缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，放弃发卡');
        return false;
    }

    const { createLarkHttpClient } = require('../channels/feishu/feishu-client');
    const { resolveFeishuChatId } = require('../channels/feishu/resolve-chat-id');

    try {
        const client = createLarkHttpClient({ appId, appSecret });
        const chatId = await resolveFeishuChatId({
            preferredChatId: process.env.FEISHU_CHAT_ID,
            larkClient: client,
        });
        if (!chatId) {
            logFailure('解析不到 chat_id，放弃发卡');
            return false;
        }
        await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        });
        return true;
    } catch (err) {
        logFailure(`发卡失败: ${err.message}`);
        return false;
    }
}

if (require.main === module) {
    sendCardFile(process.argv[2])
        .catch((err) => logFailure(`未预期错误: ${err.message}`))
        .finally(() => process.exit(0));
}

module.exports = { sendCardFile, errorLogPath };
