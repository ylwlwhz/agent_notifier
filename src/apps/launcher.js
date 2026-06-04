'use strict';

/**
 * 从飞书启动 claude 新窗口 —— 复刻 macos 分支体验，适配 Linux 本机。
 *   本地：在 CLAUDE_LAUNCH_DIR(默认 ~/coderepo) 一级子目录里 tmux 新建 detached 会话跑 claude
 *   远程：异步 spawn remote-launch.js 做 rsync 拉取 + 启动 claude-remote-shell
 * 启动后是 detached tmux 会话，由全局 hooks 自动推飞书，纯手机交互；回电脑 tmux attach 接管。
 *
 * 统一启动命令（本地/远程一致）：
 *   env ENABLE_PROMPT_CACHING_1H=1 <claude> --permission-mode bypassPermissions
 *   远程经 claude-remote-shell 透传该 env（claude-remote-shell 不清理环境变量）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const HOME = process.env.HOME;
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${HOME}/.local/bin/claude`;
const CODE_DIR = process.env.CLAUDE_LAUNCH_DIR || `${HOME}/coderepo`;
const REMOTE_HOSTS = (process.env.CLAUDE_REMOTE_HOSTS
    || 'devcloud cscg102 cscg103 cscg104 cscg106 fitten fitten2 hpc').split(/\s+/).filter(Boolean);
const REMOTE_BASE = process.env.CLAUDE_REMOTE_BASE || '~/coderepo';
const WORK_DIR = process.env.CLAUDE_WORK_DIR || `${HOME}/ClaudeWork`;

// 统一启动命令片段：本地 exec 与远程 claude-remote-shell 共用
const LAUNCH_ENV = 'ENABLE_PROMPT_CACHING_1H=1';
const LAUNCH_FLAGS = '--permission-mode bypassPermissions';

// 项目名安全白名单：进 tmux/ssh/rsync 命令前过滤，杜绝注入与空格破句
const SAFE_NAME = /^[\w.-]+$/;

/** tmux 会话名：claude-<sanitized>-<时分秒> */
function sessionName(label) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `claude-${label.replace(/[^A-Za-z0-9_-]/g, '-')}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** CODE_DIR 一级子目录（排除隐藏与含特殊字符的） */
function listLocalProjects() {
    try {
        return fs.readdirSync(CODE_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && SAFE_NAME.test(d.name))
            .map(d => d.name).sort();
    } catch { return []; }
}

/** ssh 列远程 host 的 base 下一级目录。返回 { projects } 或 { error } */
function listRemoteProjects(host) {
    const r = spawnSync('ssh', [host, `cd ${REMOTE_BASE} 2>/dev/null && ls -1d */ 2>/dev/null`],
        { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return { error: (r.stderr || r.error?.message || 'ssh 失败').trim() };
    const projects = (r.stdout || '').split('\n')
        .map(s => s.replace(/\/$/, '').trim()).filter(s => SAFE_NAME.test(s));
    return { projects };
}

/** 本地启动：tmux detached 跑 claude。返回 { name, dir } 或 { error } */
function launchLocal(projName) {
    if (!SAFE_NAME.test(projName)) return { error: `非法项目名: ${projName}` };
    const dir = path.join(CODE_DIR, projName);
    if (!fs.existsSync(dir)) return { error: `目录不存在: ${dir}` };
    const name = sessionName(projName);
    const r = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', dir,
        `exec env ${LAUNCH_ENV} ${CLAUDE_BIN} ${LAUNCH_FLAGS}`], { encoding: 'utf8' });
    if (r.status !== 0) return { error: (r.stderr || r.error?.message || 'tmux 启动失败').trim() };
    return { name, dir };
}

/** 远程启动：rsync 耗时，异步交给 detached 子进程，本函数立即返回 { name, dest } 或 { error } */
function launchRemote(host, proj, chatId) {
    if (!REMOTE_HOSTS.includes(host) || !SAFE_NAME.test(proj)) return { error: `非法主机或项目: ${host} ${proj}` };
    const dest = path.join(WORK_DIR, host, proj);
    const name = sessionName(`${host}-${proj}`);
    const child = spawn(process.execPath, [path.join(__dirname, 'remote-launch.js')], {
        env: {
            ...process.env,
            RL_HOST: host, RL_PROJ: proj, RL_BASE: REMOTE_BASE, RL_DEST: dest, RL_NAME: name,
            RL_CHAT_ID: chatId || '', RL_BIN: CLAUDE_BIN, RL_ENV: LAUNCH_ENV, RL_FLAGS: LAUNCH_FLAGS,
        },
        detached: true, stdio: 'ignore',
    });
    child.unref();
    return { name, dest };
}

module.exports = {
    REMOTE_HOSTS, CODE_DIR, REMOTE_BASE, LAUNCH_ENV, LAUNCH_FLAGS,
    listLocalProjects, listRemoteProjects, launchLocal, launchRemote,
};
