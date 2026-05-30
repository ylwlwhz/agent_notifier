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
const { card2, inputEl, escFooterRow } = require('../lib/card');
const { buildReplayPlan, firstUnanswered } = require('../lib/askq-replay');
const launcher = require('./launcher');
const { buildCompletionCard } = require('../lib/completion-card');

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
            // 文本消息：claude / ccback 命令
            'im.message.receive_v1': async (data) => {
                this.lastEventTime = Date.now();
                try { await this.handleMessage(data); }
                catch (err) { console.error('[feishu-listener] 消息处理失败:', err.message); }
            },
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

        // 启动 / 接回菜单：无 pts_device，须在终端检查前分流
        if (notification._launch) {
            return this.handleLaunch(notification, action_type, session_state_key);
        }
        if (notification._ccback) {
            return this.handleCcback(notification, action_type, session_state_key);
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

        // ── 单题单选按钮卡：点 opt_i 选项 / 输入自定义，统一走 buildReplayPlan（中断按钮落到下方通用注入）──
        if (notification._single_select) {
            const optMatch = /^opt_(\d+)$/.exec(action_type || '');
            if (action.input_value || optMatch) {
                const answers = action.input_value ? { q0_other: action.input_value } : { q0: optMatch[1] };
                this.state.removeNotification(session_state_key); // 提交即完成，先移除（兼防重复投递），后台回放
                this.replayInBackground(notification.pts_device, notification._questions, answers);
                return action.input_value ? '已发送' : '已选择';
            }
        }

        // ── 多问题 form 提交：一次收齐所有答案，按题序回放注入 TUI 问卷 ──
        if (action_type === 'submit_questions') {
            return this.handleQuestionsForm(notification, action, session_state_key);
        }

        // ── Input: 卡片输入框提交（启动/接回会话发指令、权限单键） ──
        if (action.tag === 'input' && action.input_value) {
            try {
                if (notification.notification_type === 'permission_prompt') {
                    // 权限提示期望单个按键（如 "1"、"2"、"3"），不加回车
                    await injectKeys(notification.pts_device, action.input_value.trim());
                    console.log(`[feishu-listener] 已注入按键到 ${notification.pts_device}: ${action.input_value.trim()}`);
                } else {
                    await injectText(notification.pts_device, action.input_value);
                    console.log(`[feishu-listener] 已注入文字到 ${notification.pts_device}: ${action.input_value.substring(0, 50)}`);
                }
                this.state.setLastInteractedDevice(notification.pts_device);
            } catch (err) {
                console.error('[feishu-listener] 文字注入失败:', err.message);
                return;
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

        return responseEntry.label;
    }

    /** 菜单回调 opt_N → 选项下标；非选项回调（中断/Other 等）返 -1 */
    menuIndex(action_type) {
        const m = /^opt_(\d+)$/.exec(action_type || '');
        return m ? +m[1] : -1;
    }

    /** 文本消息入口：`claude` → 本地菜单；`claude <host>` → 远程菜单；`ccback` → 会话回顾 */
    async handleMessage(data) {
        const msg = data?.message;
        if (!msg || msg.message_type !== 'text') return;
        let text = '';
        try { text = (JSON.parse(msg.content || '{}').text || '').trim(); } catch { return; }
        text = text.replace(/@_user_\d+/g, '').trim(); // 去掉 @机器人 提及占位
        const parts = text.split(/\s+/).filter(Boolean);
        const chatId = msg.chat_id;
        if (parts[0] === 'ccback') return this.sendCcbackMenu(chatId); // 接回：回顾某会话最新完成卡
        if (parts[0] !== 'claude') return; // 其余文本忽略，不干扰普通聊天
        const host = parts[1];
        console.log(`[feishu-listener] 启动命令: claude ${host || '(本地)'}`);
        if (!host) return this.sendLaunchMenu(chatId, 'local');
        if (launcher.REMOTE_HOSTS.includes(host)) return this.sendLaunchMenu(chatId, 'remote', host);
        await this.sendText(chatId, `未知主机「${host}」。可用：${launcher.REMOTE_HOSTS.join(' ')}\n或直接发 claude 启动本地`);
    }

    /** 发项目选择菜单卡（竖排按钮，opt_N → items[N]） */
    async sendLaunchMenu(chatId, mode, host) {
        let projects, title, question;
        if (mode === 'local') {
            projects = launcher.listLocalProjects();
            title = '启动 claude · 本地 ~/Code';
            question = '选择项目目录：';
        } else {
            const r = launcher.listRemoteProjects(host);
            if (r.error) return this.sendText(chatId, `❌ 列 ${host} 项目失败：${r.error}`);
            projects = r.projects;
            title = `启动 claude · ${host}`;
            question = `选择 ${host} 上的项目：`;
        }
        if (!projects.length) return this.sendText(chatId, mode === 'local' ? '~/Code 下没有项目目录' : `${host} 上没有项目`);

        const stateKey = `feishu_launch_${Date.now()}`;
        this.state.addNotification(stateKey, { created_at: Date.now(), _launch: true, mode, host: host || null, chat_id: chatId, items: projects });

        const els = [{ tag: 'markdown', content: question }];
        projects.forEach((p, i) => els.push({
            tag: 'button', text: { tag: 'plain_text', content: p }, type: i === 0 ? 'primary' : 'default',
            value: { action_type: `opt_${i}`, session_state_key: stateKey },
        }));
        await this.sendCardJson(chatId, card2({ template: 'blue', title, elements: els }));
    }

    /** 启动菜单回调：opt_N → 本地立即启动 / 远程异步拉取 */
    async handleLaunch(notification, action_type, stateKey) {
        const i = this.menuIndex(action_type);
        if (i < 0) return;
        const proj = (notification.items || [])[i];
        if (!proj) return '选项无效';
        this.state.removeNotification(stateKey);

        if (notification.mode === 'local') {
            const r = launcher.launchLocal(proj);
            if (r.error) { await this.sendText(notification.chat_id, `❌ 启动失败：${r.error}`); return '启动失败'; }
            await this.sendLaunchedCard(notification.chat_id, proj, r.name);
            return '已启动';
        }
        launcher.launchRemote(notification.host, proj, notification.chat_id);
        await this.sendText(notification.chat_id, `⏬ 正在从 ${notification.host} 拉取 ${proj}…\n完成后自动启动并通知`);
        return '正在拉取';
    }

    /** 发会话选择菜单卡（正在运行的 claude 会话，opt_N → items[N]） */
    async sendCcbackMenu(chatId) {
        const sessions = launcher.listClaudeSessions();
        if (!sessions.length) return this.sendText(chatId, '没有正在运行的 claude 会话');
        const stateKey = `feishu_ccback_${Date.now()}`;
        this.state.addNotification(stateKey, { created_at: Date.now(), _ccback: true, chat_id: chatId, items: sessions });
        const els = [{ tag: 'markdown', content: '接回哪个会话：' }];
        sessions.forEach((s, i) => els.push({
            tag: 'button', text: { tag: 'plain_text', content: s }, type: i === 0 ? 'primary' : 'default',
            value: { action_type: `opt_${i}`, session_state_key: stateKey },
        }));
        await this.sendCardJson(chatId, card2({ template: 'blue', title: '接回 claude 会话', elements: els }));
    }

    /** 接回菜单回调：opt_N → 重发该会话最新「Claude 完成」卡；空会话发报错卡 */
    async handleCcback(notification, action_type, stateKey) {
        const i = this.menuIndex(action_type);
        if (i < 0) return;
        const session = (notification.items || [])[i];
        if (!session) return '选项无效';
        this.state.removeNotification(stateKey);
        const card = buildCompletionCard(launcher.sessionTranscript(session));
        if (!card) {
            // 空会话不发死卡，照样给对话框 + 中断 + 终端 id，可直接接回
            await this.sendLaunchedCard(notification.chat_id, session, session, {
                template: 'blue', title: `接回 · ${session}`, intro: '该会话还没有输出，可在下方直接发指令接回',
            });
            return '空会话';
        }
        await this.sendCardJson(notification.chat_id, card);
        return '已回顾';
    }

    /** 发带输入框的卡、绑定会话终端——新启动会话靠它发第一条指令，ccback 空会话靠它接回。
     *  opts: { template, title, intro } 覆盖默认（启动场景） */
    async sendLaunchedCard(chatId, label, name, opts = {}) {
        const { template = 'green', title = `已启动 · ${label}`, intro = '在下方直接发指令给它' } = opts;
        const stateKey = `feishu_${name}_${Date.now()}`;
        this.state.addNotification(stateKey, {
            session_id: name, notification_type: 'launched', pts_device: `tmux:${name}`, created_at: Date.now(),
            responses: { esc: { keys: '\x1b', label: 'Esc' }, interrupt: { keys: '\x1b', label: '⛔ 中断' } },
        });
        await this.sendCardJson(chatId, card2({
            template, title,
            elements: [
                { tag: 'markdown', content: intro },
                inputEl(stateKey, '给会话发指令...'),
                escFooterRow(stateKey, `tmux:${name}`), // 中断 + 右侧终端 id
            ],
        }));
    }

    /** 发消息到群：text → 纯文本，card → 交互卡片 */
    sendText(chatId, text) { return this.send(chatId, 'text', JSON.stringify({ text })); }
    sendCardJson(chatId, card) { return this.send(chatId, 'interactive', JSON.stringify(card)); }
    async send(chatId, msgType, content) {
        if (!chatId) return;
        try {
            await this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { receive_id: chatId, msg_type: msgType, content },
            });
        } catch (err) { console.error('[feishu-listener] 发送失败:', err.message); }
    }

    /** 表单提交：校验每题已答 → 规划键序 → 回放注入 TUI 问卷 */
    async handleQuestionsForm(notification, action, stateKey) {
        const fv = action.form_value || {};
        const qs = notification._questions || [];

        const bad = firstUnanswered(fv, qs); // 某题未答则该 tab 无法前进/提交，先拦下
        if (bad >= 0) return `请回答第 ${bad + 1} 题`;

        // 提交后该卡即完成，先移除（兼防飞书 at-least-once 的重复投递）；
        // 回放耗时（多选自定义/多题 ~10s）而飞书回调须秒级响应、否则超时打断，故 fire-and-forget 后台回放、立即返回
        this.state.removeNotification(stateKey);
        this.replayInBackground(notification.pts_device, qs, fv);
        return '已提交';
    }

    /** 后台异步回放：飞书回调须秒级返回，而回放慢，故 fire-and-forget（成败仅记日志，不阻塞 handler）*/
    replayInBackground(device, questions, fv) {
        this.replayQuestions(device, questions, fv)
            .then(() => this.state.setLastInteractedDevice(device))
            .catch(err => console.error('[feishu-listener] 回放失败:', err.message));
    }

    /** 执行 askq-replay 规划出的键序（起点固定在 tab0/选项0，远程时用户不会碰终端）。
     *  keys=原始字节；text+submit=打字并回车（单选自定义）；multiCustom=文本+空格哨兵（多选自定义：
     *  该输入框 commit 滞后一个 keypress，哨兵把真实最后一字 commit 进 state，自身 pending、不进答案）。 */
    async replayQuestions(device, questions, fv) {
        for (const s of buildReplayPlan(questions, fv)) {
            if (s.keys != null) {
                await injectKeys(device, s.keys);
            } else if (s.multiCustom != null) {
                await injectKeys(device, s.multiCustom); // 文本
                await this.sleep(300);
                await injectKeys(device, ' ');           // 空格哨兵：须单独注入，作为独立 keypress 才能 commit 真实最后一字
                await this.sleep(400);
            } else if (s.text != null) {
                await (s.submit ? injectText : injectKeys)(device, s.text);
            }
            await this.sleep(s.pause || 240);
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
