'use strict';

/**
 * 跨进程「决策交汇点」——Cursor 远程控制的核心。
 *
 * 与 Claude/Codex 不同，Cursor 的 hook 是【阻塞式】子进程：Cursor 把事件 JSON 写进
 * hook 的 stdin，然后【等】hook 在 stdout 上给出裁决（permission / followup_message）。
 * 所以 Cursor 不需要 PTY 注入——只要让 hook 进程本身「等飞书那边点一下」即可。
 *
 * 但发卡的是短命 hook 进程，收回调的是长驻 feishu-listener 进程，两者必须有个会合点：
 *
 *   hook:     open(id) → 发飞书卡 → wait(id, timeout)  ──┐
 *   listener: 收到卡片回调 → resolve(id, decision)     ──┘ → hook 读到裁决 → 打印给 Cursor
 *
 * 用文件而非 socket/FIFO：进程可能分属不同用户会话（IDE 里的 Cursor vs launchd 拉起的
 * listener），文件是唯一两边都稳定可达、且崩溃后不留死锁的通道。回复走 tmp+rename 原子
 * 落盘，读侧永远不会看到半截 JSON。
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sharedTmpDir } = require('./tmp-dir');

const DEFAULT_POLL_MS = 120;
// 长等待（可达数小时）不值得全程 120ms 轮询：过了最初的响应窗口退到 1s，
// 人感知不到差别，syscall 少一个数量级
const FAST_POLL_WINDOW_MS = 30 * 1000;
const SLOW_POLL_MS = 1000;
// 兜底清理阈值：只针对「没声明截止时间」的老记录与孤儿回复；
// 声明了 expires_at 的请求一律等它自己到期（见 cleanExpired）
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
// hook 察觉超时并 close 需要一点时间，到期后再宽限一会儿才清
const CLEAN_GRACE_MS = 60 * 1000;

function defaultDir() {
    return process.env.AGENT_NOTIFIER_DECISIONS
        || path.join(sharedTmpDir(), 'agent-notifier-decisions');
}

/** 决策 id：时间戳前缀便于按龄清理，随机后缀防同毫秒碰撞 */
function newDecisionId(prefix = 'cursor') {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class DecisionBridge {
    constructor(dir) {
        this.dir = dir || defaultDir();
    }

    _requestPath(id) { return path.join(this.dir, `${id}.request.json`); }
    _replyPath(id) { return path.join(this.dir, `${id}.reply.json`); }

    _ensureDir() {
        try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* 已存在或无权限，写入时再报错 */ }
    }

    /** 原子写：tmp + rename，保证读侧不会读到半截 JSON */
    _writeAtomic(target, value) {
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(tmp, target);
    }

    _readJson(file) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    }

    /**
     * 登记一个待决策请求（hook 侧，发卡前调用）。
     * meta 多为观测与超时归因用；其中 timeoutMs 会被换算成 expires_at 落盘。
     *
     * 为什么必须落 expires_at：listener 的按龄清理和 hook 的等待时长是两个独立配置。
     * 等待 12h 而清理阈值 30min 时，请求文件会在第 30 分钟被误删 —— 用户几小时后点卡片
     * 会被告知「无人在等」，而 hook 其实还在等。把截止时间写进文件，让清理侧尊重它。
     */
    open(id, meta = {}) {
        const { timeoutMs, ...rest } = meta;
        const createdAt = Date.now();
        // pid+hostname 用于存活探测：等待窗口越长（12h 级）越需要它，否则 hook 早被
        // 杀掉（关掉 Cursor 窗口）而请求文件还在，用户点了会收到「已发送」的假成功
        const record = { id, created_at: createdAt, pid: process.pid, hostname: os.hostname(), ...rest };
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) record.expires_at = createdAt + timeoutMs;
        this._ensureDir();
        this._writeAtomic(this._requestPath(id), record);
        return id;
    }

    /**
     * 登记该请求的 hook 进程是否还活着。
     * 只在同一台机器上才做判断——远程工作区里 hook 与 listener 可能不同主机，
     * 那种情况下 pid 没有可比性，一律按「还活着」处理（退回超时兜底）。
     */
    _waiterAlive(request) {
        if (!request) return false;
        if (!request.pid || !request.hostname) return true;
        if (request.hostname !== os.hostname()) return true;
        try {
            process.kill(request.pid, 0); // 信号 0 只探测存在性，不影响目标进程
            return true;
        } catch (err) {
            return err.code === 'EPERM'; // 进程在但不属于我们：仍算活着
        }
    }

    /** 请求是否还在等待（listener 用来判断「卡片是否已被本地/超时接管」） */
    isPending(id) {
        if (!fs.existsSync(this._requestPath(id))) return false;
        if (fs.existsSync(this._replyPath(id))) return false;
        return this._waiterAlive(this.getRequest(id));
    }

    getRequest(id) { return this._readJson(this._requestPath(id)); }

    /**
     * 列出仍在等待的请求 id，可按 session_id / event 过滤。
     *
     * 用途是「同一会话只保留一张待回复的卡」：等待窗口长达 24h 时，每轮结束都会留下一个
     * 阻塞进程和一张永久有效的卡。攒上几个之后，用户回复旧卡会把续写注入到几小时前就
     * 结束的那一轮里 —— 所以新一轮开始前要先把上一轮那张收敛掉。
     */
    listPending({ sessionId, event } = {}) {
        let names;
        try { names = fs.readdirSync(this.dir); } catch { return []; }

        const ids = [];
        for (const name of names) {
            const m = /^(.+)\.request\.json$/.exec(name);
            if (!m) continue;
            const request = this.getRequest(m[1]);
            if (!request) continue;
            if (sessionId && request.session_id !== sessionId) continue;
            if (event && request.event !== event) continue;
            if (!this.isPending(m[1])) continue;
            ids.push(m[1]);
        }
        return ids;
    }

    /**
     * 写入裁决（listener 侧）。返回 false 表示无人在等（请求不存在或已被裁决），
     * 调用方据此告诉用户「这次点击来晚了」，而不是假报成功。
     */
    resolve(id, decision = {}) {
        if (!id) return false;
        this._ensureDir();
        if (!fs.existsSync(this._requestPath(id))) return false;
        if (fs.existsSync(this._replyPath(id))) return false;
        // 等待方已经不在了（Cursor 被关掉 / hook 被 kill）→ 写了也没人读，
        // 如实回 false 让 listener 告诉用户「本次点击未生效」，而不是假报成功
        if (!this._waiterAlive(this.getRequest(id))) return false;
        this._writeAtomic(this._replyPath(id), { id, decided_at: Date.now(), decision });
        return true;
    }

    /** 读裁决，未决返回 null */
    read(id) {
        const reply = this._readJson(this._replyPath(id));
        return reply ? reply.decision || {} : null;
    }

    /**
     * 阻塞等待裁决。超时返回 null —— 调用方必须据此回落到宿主本地行为
     * （审批回 permission:'ask' 让 Cursor 自己弹窗，followup 回空对象让本轮正常结束），
     * 绝不能让 Cursor 永久卡在 hook 上。
     */
    async wait(id, { timeoutMs = 180000, pollMs = DEFAULT_POLL_MS } = {}) {
        const deadline = Date.now() + timeoutMs;
        const fastUntil = Date.now() + FAST_POLL_WINDOW_MS;
        for (;;) {
            const decision = this.read(id);
            if (decision) return decision;
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            const interval = Date.now() < fastUntil ? pollMs : Math.max(pollMs, SLOW_POLL_MS);
            await sleep(Math.min(interval, remaining));
        }
    }

    /** 收摊：hook 拿到裁决/超时后调用，避免 /tmp 里堆积 */
    close(id) {
        for (const file of [this._requestPath(id), this._replyPath(id)]) {
            try { fs.unlinkSync(file); } catch { /* 不存在即已清理 */ }
        }
    }

    /**
     * 清理崩溃残留（hook 被 kill 时不会走 close）。
     *
     * 按 id 成对处理，而不是逐文件按 mtime 删：请求与回复是一个整体，
     * 单独删掉其中一个会让还在等的 hook 永远读不到裁决。
     * 声明了 expires_at 的请求一律等它自己到期（+宽限），maxAgeMs 只管兜底老记录。
     */
    cleanExpired(maxAgeMs = DEFAULT_MAX_AGE_MS) {
        let names;
        try { names = fs.readdirSync(this.dir); } catch { return 0; }

        const groups = new Map();
        for (const name of names) {
            const m = /^(.+)\.(request|reply)\.json$/.exec(name);
            if (!m) continue;
            if (!groups.has(m[1])) groups.set(m[1], []);
            groups.get(m[1]).push(name);
        }

        const now = Date.now();
        let removed = 0;
        for (const [id, files] of groups) {
            const request = this.getRequest(id);
            const alive = this._waiterAlive(request);
            // hook 还活着且自己声明的截止时间未到 → 整组保留。
            // 进程已死则立即可回收，不必陪着长达 12h 的 expires_at 干等。
            if (alive && request?.expires_at && now < request.expires_at + CLEAN_GRACE_MS) continue;
            for (const name of files) {
                const file = path.join(this.dir, name);
                try {
                    const stale = !alive
                        || (request?.expires_at
                            ? now > request.expires_at + CLEAN_GRACE_MS
                            : now - fs.statSync(file).mtimeMs > maxAgeMs);
                    if (stale) { fs.unlinkSync(file); removed++; }
                } catch { /* 并发清理，忽略 */ }
            }
        }
        return removed;
    }
}

module.exports = {
    DecisionBridge,
    decisionBridge: new DecisionBridge(),
    newDecisionId,
};
