#!/usr/bin/env node
'use strict';

/**
 * 回放子进程：把一组答案按 askq-replay 规划的键序注入 TUI 问卷。
 *
 * listener 收到飞书提交后 spawn 本进程（detached）再立即回 toast。SDK 是在 handler return 之后才异步发
 * card.action.trigger 的 response 帧（走 WS/TLS），若主进程紧接着跑几秒的注入（一连串子进程），会把那一帧
 * 的网络发送推迟过飞书前端的 3s 窗口而误报「超时未响应」。把回放放到独立进程，主进程发完 toast 帧即空闲，
 * 帧能瞬间上线、超时窗口物理消失。入参经环境变量：RW_DEVICE=终端，RW_PAYLOAD=JSON({questions, fv})。
 */

require('../lib/env-config');
const { buildReplayPlan } = require('../lib/askq-replay');
const { injectKeys, injectText } = require('../lib/terminal-inject');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    const device = process.env.RW_DEVICE;
    let payload = {};
    try { payload = JSON.parse(process.env.RW_PAYLOAD || '{}'); } catch {}
    const { questions, fv } = payload;
    if (!device || !Array.isArray(questions)) return;

    // keys=原始字节；text+submit=打字并回车（单选自定义）；multiCustom=文本+空格哨兵（多选自定义：
    // 输入框 commit 滞后一个 keypress，哨兵把真实最后一字 commit 进 state、须单独注入、自身 pending 不进答案）
    for (const s of buildReplayPlan(questions, fv)) {
        if (s.keys != null) {
            await injectKeys(device, s.keys);
        } else if (s.multiCustom != null) {
            await injectKeys(device, s.multiCustom);
            await sleep(300);
            await injectKeys(device, ' ');
            await sleep(400);
        } else if (s.text != null) {
            await (s.submit ? injectText : injectKeys)(device, s.text);
        }
        await sleep(s.pause || 240);
    }
}

main().catch(err => { console.error('[replay-worker]', err.message); }).then(() => process.exit(0));
