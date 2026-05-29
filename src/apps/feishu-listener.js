/**
 * 飞书监听器 - WebSocket 长连接守护进程
 * 接收飞书卡片按钮回调和消息，通过 TIOCSTI 注入到 Claude Code 终端
 *
 * 启动方式:
 *   node feishu-listener.js              # 前台运行
 *   npm run feishu-listener:start        # 后台守护
 */

'use strict';

require('../lib/env-config');
const Lark = require('@larksuiteoapi/node-sdk');
const { SessionState } = require('../lib/session-state');
const { injectKeys, injectText } = require('../lib/terminal-inject');
const { createFeishuClient } = require('../channels/feishu/feishu-client');
const { createFeishuInteractionHandler } = require('../channels/feishu/feishu-interaction-handler');
const { createCodexInputBridge } = require('../adapters/codex/cli-input-bridge');
const { selectCard, card2 } = require('../lib/card');
const { parseMarkdownToElements } = require('../lib/feishu-card-utils');

const WS_MAX_AGE_MS = parseInt(process.env.FEISHU_WS_MAX_AGE_MIN || '25', 10) * 60_000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

class FeishuListener {
    constructor() {
        this.state = new SessionState();
        this.lastEventTime = Date.now();

        const appId = process.env.FEISHU_APP_ID;
        const appSecret = process.env.FEISHU_APP_SECRET;

        if (!appId || !appSecret) {
            console.error('[feishu-listener] 缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET');
            process.exit(1);
        }

        this.appId = appId;
        this.appSecret = appSecret;

        // Create Lark API client (for future API calls like listing chats)
        this.feishuClient = createFeishuClient({
            appId: this.appId,
            appSecret: this.appSecret,
        });
        this.client = this.feishuClient.client;

        this.codexInputBridge = createCodexInputBridge({
            deliver: async (target, text) => injectKeys(target, text),
        });
        this.unifiedInteractionHandler = createFeishuInteractionHandler({
            resolveInteraction: async (key) => {
                const entry = this.state.getNotification(key);
                if (!entry) return null;
                return {
                    sessionId: entry.session_id || 'codex_unknown',
                    host: entry.host || 'claude',
                };
            },
            onResponse: async (response) => {
                if (response.host !== 'codex') return null;
                const entry = this.state.getNotification(response.interactionKey);
                if (!entry?.pts_device) return null;
                const isSummaryTextInput = (
                    response.responseType === 'text' &&
                    (entry.notification_type === 'live_summary' || entry.notification_type === 'execution_summary')
                );
                if (isSummaryTextInput) {
                    await injectText(entry.pts_device, response.value || '');
                } else {
                    await this.codexInputBridge.send(response, entry.pts_device, {
                        interruptBeforeText: entry.notification_type === 'live_summary' && response.responseType === 'text',
                    });
                }
                this.state.setLastInteractedDevice(entry.pts_device);
                console.log(
                    `[feishu-listener] codex 已注入 ${response.responseType} 到 ${entry.pts_device}:`,
                    response.values || response.value || ''
                );
                return true;
            },
        });
    }

    start() {
        // Create event dispatcher — 长连接模式下所有事件注册在 EventDispatcher 中
        this.eventDispatcher = new Lark.EventDispatcher({}).register({
            // 卡片交互回调（按钮点击 + 输入框提交）
            'card.action.trigger': async (data) => {
                this.lastEventTime = Date.now();
                const result = await this.handleCardAction(data);
                // 其他操作弹 toast
                if (result && typeof result === 'object' && result.card) {
                    return {
                        toast: { type: 'success', content: result.label || '已操作' },
                        card: result.card,
                    };
                }
                return {
                    toast: { type: 'success', content: (typeof result === 'string' ? result : null) || '已操作' },
                };
            },
        });

        // Create WebSocket client
        this.wsClient = new Lark.WSClient({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: Lark.LoggerLevel.info,
        });

        // Start WebSocket connection
        this.wsClient.start({ eventDispatcher: this.eventDispatcher });

        console.log('[feishu-listener] 飞书监听器已启动，等待用户操作...');

        // Periodic health check for WebSocket connection staleness
        this.healthCheckInterval = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL_MS);

        // Periodic cleanup of expired notifications
        this.cleanupInterval = setInterval(() => {
            this.state.cleanExpired();
        }, 60000);
    }

    /**
     * Handle card action callback (button click or input submit)
     *
     * Button: { action: { tag: 'button', value: { action_type, session_state_key } } }
     * Input:  { action: { tag: 'input', input_value: '...', value: { action_type, session_state_key } } }
     */
    async handleCardAction(data) {
        const action = data?.action;
        console.log('[feishu-listener] 收到回调 action_type:', action?.value?.action_type, 'key:', action?.value?.session_state_key?.substring(0, 20));
        console.log('[feishu-listener] data keys:', Object.keys(data || {}));
        if (!action || !action.value) {
            console.log('[feishu-listener] 收到无效的卡片回调');
            return;
        }

        const { action_type, session_state_key } = action.value;
        if (!session_state_key) {
            console.log('[feishu-listener] 卡片回调缺少 session_state_key');
            return;
        }

        // Look up the pending notification
        const notification = this.state.getNotification(session_state_key);
        if (!notification) {
            console.log('[feishu-listener] 通知已过期或已处理:', session_state_key);
            return;
        }

        // Check terminal target
        if (!notification.pts_device) {
            console.log('[feishu-listener] 终端未找到，无法注入');
            return;
        }

        if (notification.host === 'codex') {
            try {
                const response = await this.unifiedInteractionHandler.handleCardAction(data);
                if (!response) return;
                return '已发送';
            } catch (err) {
                console.error('[feishu-listener] codex 回调处理失败:', err.message);
                return '处理失败';
            }
        }

        // ── 多选卡片：输入框提交（必须在通用 input 处理之前） ──
        if (action_type === 'submit_multi') {
            const inputText = (action.input_value || '').trim();
            if (!inputText) return '请输入选项编号';

            const total = notification._ms_total || (notification._ms_options || []).length;
            const otherNum = total + 1; // Other 的 1-indexed 编号

            // 解析输入：支持 "1 3" 或 "1 4:自定义文本"
            // 先提取 Other 文本（格式：otherNum:文本 或 otherNum：文本）
            let otherText = null;
            const otherMatch = inputText.match(new RegExp(`${otherNum}[:：](.+)`));
            if (otherMatch) {
                otherText = otherMatch[1].trim();
            }

            // 提取所有编号
            const nums = inputText.split(/[\s,，、]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (nums.length === 0) return '请输入有效的选项编号';

            // 转为 0-indexed：选项 0..total-1，Other = total
            const selectedSet = new Set(nums.map(n => n - 1).filter(i => i >= 0 && i <= total));
            // 如果有 otherText，确保 Other 被选中
            if (otherText) selectedSet.add(total - 1 + 1); // Other index = total (0-indexed)
            // 过滤：正常选项 0..total-1，Other = total
            const hasOther = selectedSet.has(total);

            if (selectedSet.size === 0) return `请输入有效的选项编号（1 到 ${otherNum}）`;

            console.log(`[feishu-listener] submit_multi → selected:`, [...selectedSet], 'total:', total, 'hasOther:', hasOther, 'otherText:', otherText);

            try {
                // 终端结构：选项0..N-1 + Other + Submit（共 N+2 项）
                const totalItems = total + 1; // 选项 + Other
                const injected = []; // 调试日志
                for (let i = 0; i < totalItems; i++) {
                    if (i === total && hasOther) {
                        // Other 特殊处理：Space 打开内联输入 → 输入文本 → Enter 关闭
                        await injectKeys(notification.pts_device, '\x20'); // Space 打开 Other 输入
                        injected.push(`Space@${i}(Other)`);
                        await this.sleep(300);
                        if (otherText) {
                            await injectKeys(notification.pts_device, otherText); // 只发文本，不发 Enter
                            injected.push(`Text("${otherText}")`);
                            await this.sleep(300);
                        }
                    } else if (selectedSet.has(i)) {
                        await injectKeys(notification.pts_device, '\x20'); // Space 勾选
                        injected.push(`Space@${i}`);
                        await this.sleep(300);
                    }
                    await injectKeys(notification.pts_device, '\x1b[B'); // ↓ 下一项
                    injected.push(`Down`);
                    await this.sleep(300);
                }
                // cursor 现在在 Submit 上
                injected.push('Enter');
                await injectKeys(notification.pts_device, '\r'); // Enter 提交 checkbox
                console.log(`[feishu-listener] 注入序列:`, injected.join(' → '), '| device:', notification.pts_device);

                // 等待确认对话框 "Submit answers / Cancel"，按 1 确认
                await this.sleep(500);
                await injectKeys(notification.pts_device, '1'); // 选择 "Submit answers"
                this.state.setLastInteractedDevice(notification.pts_device);
            } catch (err) {
                console.error('[feishu-listener] 多选注入失败:', err.message);
                return '注入失败';
            }

            const opts = notification._ms_options || [];
            const labels = [...selectedSet].sort((a, b) => a - b)
                .map(i => i < total ? (opts[i] || `选项${i + 1}`) : `Other: ${otherText || ''}`);
            this.state.removeNotification(session_state_key);
            return `已提交: ${labels.join(', ')}`;
        }

        // ── Input: 用户在卡片输入框中输入了文字 ──
        if (action.tag === 'input' && action.input_value) {
            try {
                if (notification.notification_type === 'permission_prompt') {
                    // 权限提示期望单个按键（如 "1"、"2"、"3"），不加回车
                    await injectKeys(notification.pts_device, action.input_value.trim());
                    console.log(`[feishu-listener] 已注入按键到 ${notification.pts_device}: ${action.input_value.trim()}`);
                } else {
                    // 普通文本输入：含回车
                    // 如果有 _other_num 且 Other 按钮尚未被点击，先注入 Other 序号
                    const otherMeta = notification.responses?.['_other_num'];
                    const otherAlreadyClicked = notification._other_clicked;
                    if (otherMeta && !otherAlreadyClicked) {
                        await injectKeys(notification.pts_device, otherMeta.keys);
                        await this.sleep(500);
                    }
                    await injectText(notification.pts_device, action.input_value);
                    console.log(`[feishu-listener] 已注入文字到 ${notification.pts_device}: ${action.input_value.substring(0, 50)}`);
                }
                this.state.setLastInteractedDevice(notification.pts_device);
            } catch (err) {
                console.error('[feishu-listener] 文字注入失败:', err.message);
                return;
            }
            // 多问题模式：删除并发送下一题；普通卡片：保留以支持多次回复
            if (notification._all_questions) {
                this.state.removeNotification(session_state_key);
                this.sendNextQuestion(notification, session_state_key).catch(err =>
                    console.error('[feishu-listener] 发送下一题失败:', err.message));
            }
            return '已发送';
        }

        // ── Button: 直接注入 ──
        if (!action_type) return;

        const responseEntry = notification.responses?.[action_type];
        if (!responseEntry) {
            console.log('[feishu-listener] 未知操作:', action_type);
            return;
        }

        try {
            await injectKeys(notification.pts_device, responseEntry.keys);
            console.log(`[feishu-listener] 已注入按键到 ${notification.pts_device}: ${responseEntry.label}`);
            this.state.setLastInteractedDevice(notification.pts_device);
        } catch (err) {
            console.error('[feishu-listener] 注入失败:', err.message);
            return;
        }

        // bypass 按钮：注入后还要把终端加入 autoApproveDevices
        if (action_type === 'bypass' && notification.pts_device) {
            this.state.load();
            const meta = this.state.data['__meta__'] || {};
            const devices = new Set(meta.autoApproveDevices || []);
            devices.add(notification.pts_device);
            this.state.data['__meta__'] = { ...meta, autoApproveDevices: [...devices], updated_at: Date.now() };
            this.state.save();
            console.log(`[feishu-listener] 已开启全局允许: ${notification.pts_device}`);
            return '已开启全局允许，后续权限自动批准';
        }

        // Other 按钮保留 notification 等待输入框
        // 多问题模式按钮：删除并发下一题
        // 普通卡片按钮（esc/allow 等）：保留以支持多次操作
        if (action_type === 'opt_other') {
            notification._other_clicked = true;
            this.state.load();
            this.state.data[session_state_key] = notification;
            this.state.save();
        } else if (notification._all_questions) {
            this.state.removeNotification(session_state_key);
            this.sendNextQuestion(notification, session_state_key).catch(err =>
                console.error('[feishu-listener] 发送下一题失败:', err.message));
        }
        return responseEntry.label;
    }

    /**
     * 多问题模式：发送下一题卡片，或最后的提交/取消卡片
     */
    async sendNextQuestion(notification, prevStateKey) {
        const questions = notification._all_questions;
        const nextIdx = (notification._current_q || 0) + 1;
        const chatId = notification._chat_id;
        const noteParts = notification._note_parts || '';
        const totalQ = questions.length;

        if (!chatId) return;

        // 生成新的 stateKey（基于当前 key 替换末尾）
        const baseKey = prevStateKey.replace(/_q\d+$/, '').replace(/_confirm$/, '');
        const newStateKey = `${baseKey}_q${nextIdx}`;

        if (nextIdx < totalQ) {
            // 还有下一题
            const q = questions[nextIdx];
            const ARROW_DOWN = '\x1b[B';
            const otherIdx = q.options.length;

            const qResponses = {};
            q.options.forEach((opt, optIdx) => {
                qResponses[`opt_${optIdx}`] = { keys: ARROW_DOWN.repeat(optIdx) + '\r', label: opt.label };
            });
            qResponses['opt_other'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: 'Other' };
            qResponses['_other_num'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: '_meta' };
            qResponses['interrupt'] = { keys: '\x1b', label: '⛔ Interrupt' };

            // 保存 state（沿用多问题元数据）
            this.state.addNotification(newStateKey, {
                session_id: notification.session_id,
                notification_type: notification.notification_type,
                pts_device: notification.pts_device,
                created_at: Date.now(),
                responses: qResponses,
                _all_questions: questions,
                _current_q: nextIdx,
                _chat_id: chatId,
                _note_parts: noteParts,
            });

            // 发送卡片（schema 2.0，与 claude-ask 同款 selectCard）
            const qCard = selectCard({
                title: `${q.header || '选择'} (${nextIdx + 1}/${totalQ})`,
                question: q.question || '',
                options: q.options.map(o => o.label),
                stateKey: newStateKey, noteParts,
                mdToEls: parseMarkdownToElements,
            });

            try {
                await this.client.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(qCard) },
                });
                console.log(`[feishu-listener] 已发送 Q${nextIdx + 1}/${totalQ} 卡片`);
            } catch (err) {
                console.error(`[feishu-listener] 发送 Q${nextIdx + 1} 卡片失败:`, err.message);
            }
        } else {
            // 所有问题已回答 — 所有答案在逐题 Enter 时已注入终端，此处仅发状态通知
            // 不存 sessionState、不带注入按钮，避免多注入一个 Enter 到错误上下文
            const doneCard = card2({
                template: 'green',
                title: `全部已回答 (${totalQ} 题)`,
                elements: [{ tag: 'markdown', content: noteParts }],
            });

            try {
                await this.client.im.message.create({
                    params: { receive_id_type: 'chat_id' },
                    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(doneCard) },
                });
                console.log('[feishu-listener] 已发送多问题完成通知');
            } catch (err) {
                console.error('[feishu-listener] 发送完成通知失败:', err.message);
            }
        }
    }

    checkHealth() {
        try {
            const info = this.wsClient.getReconnectInfo();
            const age = Date.now() - info.lastConnectTime;
            if (age > WS_MAX_AGE_MS) {
                console.log(`[feishu-listener] WebSocket 连接已 ${Math.round(age / 60000)} 分钟未刷新，主动重连...`);
                this.reconnect();
            }
        } catch (err) {
            console.error('[feishu-listener] 健康检查异常:', err.message);
        }
    }

    reconnect() {
        try {
            this.wsClient.close();
        } catch (err) {
            console.error('[feishu-listener] 关闭旧连接失败:', err.message);
        }
        this.wsClient = new Lark.WSClient({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: Lark.LoggerLevel.info,
        });
        this.wsClient.start({ eventDispatcher: this.eventDispatcher });
        this.lastEventTime = Date.now();
        console.log('[feishu-listener] WebSocket 已重新连接');
    }

    stop() {
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        console.log('[feishu-listener] 监听器已停止');
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Main entry point
if (require.main === module) {
    main();
}

function main() {
    const listener = new FeishuListener();

    process.on('SIGINT', () => { listener.stop(); process.exit(0); });
    process.on('SIGTERM', () => { listener.stop(); process.exit(0); });

    listener.start();
    return listener;
}

module.exports = { FeishuListener, main };
