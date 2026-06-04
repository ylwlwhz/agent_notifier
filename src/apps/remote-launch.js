#!/usr/bin/env node
'use strict';

/**
 * launcher.launchRemote 异步 spawn 的后台进程：rsync 拉取远程项目到本地镜像 →
 * tmux detached 启动 claude-remote-shell → 回飞书通知成败。参数全走 RL_* 环境变量。
 *
 * 启动命令：env <RL_ENV> claude-remote-shell <host:base/proj> <claude> <RL_FLAGS>
 *   claude-remote-shell 不清理环境变量，RL_ENV(ENABLE_PROMPT_CACHING_1H=1) 会透传给 claude。
 */

require('../lib/env-config');
const fs = require('fs');
const { spawnSync } = require('child_process');

const { RL_HOST, RL_PROJ, RL_BASE, RL_DEST, RL_NAME, RL_CHAT_ID, RL_BIN, RL_ENV, RL_FLAGS, RL_PROXY } = process.env;

// claude（本地跑、Bash 转远程）仍需境外代理访问 Anthropic API → 启动前 source 代理脚本
const PROXY_PREFIX = RL_PROXY ? `source ${RL_PROXY} && ` : '';

// 没有 ~/.mutagen.yml / yq 时的兜底排除集，避免把巨大无用目录 rsync 过来
const DEFAULT_EXCLUDES = ['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.cache'];

/** 优先从 ~/.mutagen.yml 派生 rsync exclude（需 yq）；无 yq/无文件则用兜底集 */
function rsyncExcludes() {
    const yml = `${process.env.HOME}/.mutagen.yml`;
    if (fs.existsSync(yml) && spawnSync('yq', ['--version'], { encoding: 'utf8' }).status === 0) {
        const r = spawnSync('yq', ['.sync.defaults.ignore.paths[]', yml], { encoding: 'utf8' });
        if (r.status === 0) {
            const paths = (r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
            if (paths.length) return paths.map(p => `--exclude=${p}`);
        }
    }
    return DEFAULT_EXCLUDES.map(p => `--exclude=${p}`);
}

async function notify(text, template) {
    const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret } = process.env;
    if (!appId || !appSecret || !RL_CHAT_ID) return;
    try {
        const Lark = require('@larksuiteoapi/node-sdk');
        const { card2 } = require('../lib/card');
        const card = card2({ template, title: 'claude 远程启动', elements: [{ tag: 'markdown', content: text }] });
        await new Lark.Client({ appId, appSecret }).im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: RL_CHAT_ID, msg_type: 'interactive', content: JSON.stringify(card) },
        });
    } catch {}
}

/** 启动成功：发带输入框的卡 + 登记新会话终端，供飞书直接发指令（与 listener.sendLaunchedCard 对称） */
async function announceReady() {
    const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret } = process.env;
    if (!appId || !appSecret || !RL_CHAT_ID) return;
    try {
        const Lark = require('@larksuiteoapi/node-sdk');
        const { card2, inputEl, escFooterRow } = require('../lib/card');
        const { SessionState } = require('../lib/session-state');
        const stateKey = `feishu_${RL_NAME}_${Date.now()}`;
        new SessionState().addNotification(stateKey, {
            session_id: RL_NAME, notification_type: 'launched', pts_device: `tmux:${RL_NAME}`, created_at: Date.now(),
            responses: { esc: { keys: '\x1b', label: 'Esc' }, interrupt: { keys: '\x1b', label: '⛔ 中断' } },
        });
        const card = card2({
            template: 'green', title: `已启动 · ${RL_HOST}:${RL_PROJ}`,
            elements: [
                { tag: 'markdown', content: '在下方直接发指令给它' },
                inputEl(stateKey, '给新会话发指令...'),
                escFooterRow(stateKey, `tmux:${RL_NAME}`), // 中断 + 右侧终端 id
            ],
        });
        await new Lark.Client({ appId, appSecret }).im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: RL_CHAT_ID, msg_type: 'interactive', content: JSON.stringify(card) },
        });
    } catch {}
}

async function main() {
    fs.mkdirSync(RL_DEST, { recursive: true });
    const rsync = spawnSync('rsync',
        ['-az', '--delete', '--delete-excluded', ...rsyncExcludes(), '-e', 'ssh', `${RL_HOST}:${RL_BASE}/${RL_PROJ}/`, `${RL_DEST}/`],
        { encoding: 'utf8', timeout: 600000 });
    if (rsync.status !== 0) {
        await notify(`❌ 拉取 ${RL_HOST}:${RL_PROJ} 失败\n\`\`\`\n${(rsync.stderr || rsync.error?.message || '').slice(-500)}\n\`\`\``, 'red');
        return;
    }
    // 本地 tmux 跑 claude-remote-shell：编辑本地镜像，Bash 工具命令重定向到远程 host
    try { require('./launcher').ensureTrusted(RL_DEST); } catch {} // 跳过 trust this folder 弹窗
    const tmux = spawnSync('tmux', ['new-session', '-d', '-s', RL_NAME, '-c', RL_DEST,
        `${PROXY_PREFIX}exec env ${RL_ENV} claude-remote-shell ${RL_HOST}:${RL_BASE}/${RL_PROJ} ${RL_BIN} ${RL_FLAGS}`],
        { encoding: 'utf8' });
    if (tmux.status !== 0) {
        await notify(`❌ tmux 启动失败：${(tmux.stderr || '').trim()}`, 'red');
        return;
    }
    await announceReady();
}

main();
