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
const REMOTE_BASE = process.env.CLAUDE_REMOTE_BASE || '~/coderepo';
const WORK_DIR = process.env.CLAUDE_WORK_DIR || `${HOME}/ClaudeWork`;

// 统一启动命令片段：本地 exec 与远程 claude-remote-shell 共用
const LAUNCH_ENV = 'ENABLE_PROMPT_CACHING_1H=1';
const LAUNCH_FLAGS = '--permission-mode bypassPermissions';

// claude 需境外代理访问 Anthropic API：启动前 source 代理脚本（默认 ~/proxy_local.sh）
const PROXY_SCRIPT = process.env.CLAUDE_PROXY_SCRIPT || `${HOME}/proxy_local.sh`;

/** 代理前缀：脚本存在才加 `source <script> &&`，否则空串 */
function proxyPrefix() {
    return fs.existsSync(PROXY_SCRIPT) ? `source ${PROXY_SCRIPT} && ` : '';
}

/**
 * 预置目录信任，跳过 claude 首次进入未信任目录的 "trust this folder" 弹窗
 * （两种权限 flag 都不跳过该弹窗，只能靠 ~/.claude.json 里 hasTrustDialogAccepted）。
 * 仅在该目录尚未信任时写一次（原子 rename）；配置缺失/损坏则不动，避免误伤。
 */
function ensureTrusted(dir) {
    const cfgPath = `${HOME}/.claude.json`;
    try {
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return; }
        if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
        const cur = cfg.projects[dir];
        if (cur && cur.hasTrustDialogAccepted === true) return; // 已信任，免写
        cfg.projects[dir] = {
            allowedTools: [], ...(cur || {}),
            hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true,
        };
        const tmp = `${cfgPath}.launcher.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
        fs.renameSync(tmp, cfgPath);
    } catch {}
}

// 项目名安全白名单：进 tmux/ssh/rsync 命令前过滤，杜绝注入与空格破句
const SAFE_NAME = /^[\w.-]+$/;
// 绝对路径安全集（手动输入路径用）：仅放行路径字符，禁 shell 元字符/空格，防注入
const PATH_SAFE = /^[\w./~-]+$/;
// 主机名安全集：白名单已取消（任意主机放行），仅保留注入防护，允许 user@host.name-1
const HOST_SAFE = /^[\w.@-]+$/;

/** 主机名是否安全（仅注入防护，不再做白名单校验） */
function isHostSafe(host) { return !!host && HOST_SAFE.test(host); }

/** "项目名 或 绝对路径" → 本地目录。返回 { dir, label } 或 { error } */
function resolveLocalDir(projOrPath) {
    let dir, label;
    if (projOrPath.startsWith('/') || projOrPath.startsWith('~')) {
        if (!PATH_SAFE.test(projOrPath)) return { error: `非法路径: ${projOrPath}` };
        dir = projOrPath.startsWith('~') ? path.join(HOME, projOrPath.slice(1)) : projOrPath;
        label = path.basename(dir.replace(/\/+$/, '')) || dir;
    } else {
        if (!SAFE_NAME.test(projOrPath)) return { error: `非法项目名: ${projOrPath}` };
        dir = path.join(CODE_DIR, projOrPath);
        label = projOrPath;
    }
    if (!fs.existsSync(dir)) return { error: `目录不存在: ${dir}` };
    return { dir, label };
}

/** "项目名 或 远程绝对路径" → { base, name }（base/name 拼回远程路径）或 { error } */
function resolveRemoteProj(projOrPath) {
    const clean = projOrPath.replace(/\/+$/, '');
    if (clean.startsWith('/') || clean.startsWith('~')) {
        if (!PATH_SAFE.test(clean)) return { error: `非法路径: ${projOrPath}` };
        const name = path.posix.basename(clean);
        if (!name) return { error: `路径无效: ${projOrPath}` };
        return { base: path.posix.dirname(clean), name };
    }
    if (!SAFE_NAME.test(clean)) return { error: `非法项目名: ${projOrPath}` };
    return { base: REMOTE_BASE, name: clean };
}

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

/** 本地启动：tmux detached 跑 claude。projOrPath = 菜单项目名 或 绝对路径。返回 { name, dir, label } 或 { error } */
function launchLocal(projOrPath) {
    const r0 = resolveLocalDir(projOrPath);
    if (r0.error) return r0;
    const { dir, label } = r0;
    const name = sessionName(label);
    ensureTrusted(dir); // 跳过 trust this folder 弹窗
    const r = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', dir,
        `${proxyPrefix()}exec env ${LAUNCH_ENV} ${CLAUDE_BIN} ${LAUNCH_FLAGS}`], { encoding: 'utf8' });
    if (r.status !== 0) return { error: (r.stderr || r.error?.message || 'tmux 启动失败').trim() };
    return { name, dir, label };
}

/** 远程启动：rsync 耗时，异步交给 detached 子进程，本函数立即返回 { name, dest, label } 或 { error }。
 *  projOrPath = 菜单项目名（拼到 REMOTE_BASE 下）或 远程绝对路径（直接用）。白名单已取消，仅注入防护。 */
function launchRemote(host, projOrPath, chatId) {
    if (!isHostSafe(host)) return { error: `非法主机名: ${host}` };
    const rp = resolveRemoteProj(projOrPath);
    if (rp.error) return rp;
    const { base, name: projName } = rp;
    const dest = path.join(WORK_DIR, host.replace(/[^\w.-]/g, '_'), projName);
    const name = sessionName(`${host}-${projName}`);
    const child = spawn(process.execPath, [path.join(__dirname, 'remote-launch.js')], {
        env: {
            ...process.env,
            RL_HOST: host, RL_PROJ: projName, RL_BASE: base, RL_DEST: dest, RL_NAME: name,
            RL_CHAT_ID: chatId || '', RL_BIN: CLAUDE_BIN, RL_ENV: LAUNCH_ENV, RL_FLAGS: LAUNCH_FLAGS,
            RL_PROXY: fs.existsSync(PROXY_SCRIPT) ? PROXY_SCRIPT : '',
        },
        detached: true, stdio: 'ignore',
    });
    child.unref();
    return { name, dest, label: projName };
}

module.exports = {
    CODE_DIR, REMOTE_BASE, LAUNCH_ENV, LAUNCH_FLAGS, isHostSafe,
    listLocalProjects, listRemoteProjects, launchLocal, launchRemote, ensureTrusted,
};
