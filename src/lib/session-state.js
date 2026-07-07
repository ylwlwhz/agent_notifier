'use strict';

const fs = require('fs');
const path = require('path');
const { createSessionStore } = require('../core/session-store');
const { createCardStateStore } = require('../core/card-state-store');

// 文件锁参数。STALE 取较小值：正常持锁仅数毫秒，1.5s 仍存在即视为持锁进程已崩溃。
const LOCK_STALE_MS = 1500;
const LOCK_TIMEOUT_MS = 2500; // 等不到锁就降级为无锁执行，宁可偶发竞态也不卡死
const LOCK_SPIN_MS = 15;

/** 同步睡眠（不空转 CPU）；仅用于短命的 hook 进程，长驻进程请用异步锁 */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sleepAsync(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class SessionState {
    constructor(statePath) {
        this.statePath =
            statePath ||
            process.env.AGENT_NOTIFIER_STATE ||
            path.join(__dirname, '..', 'session-state.json');
        this.tmpPath = this.statePath + '.tmp';
        this.lockPath = this.statePath + '.lock';
        this.data = {};
    }

    /** 抢锁一次。返回 'held'(拿到) | 'wait'(稍后重试) | 'degrade'(放弃，降级无锁执行) */
    _lockAttempt(deadline) {
        try {
            fs.mkdirSync(this.lockPath);
            return 'held';
        } catch (err) {
            if (err.code !== 'EEXIST') return 'degrade'; // 异常文件系统：直接降级
            try {
                if (Date.now() - fs.statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
                    fs.rmdirSync(this.lockPath); // 接管陈旧锁
                    return 'wait';
                }
            } catch {}
            return Date.now() > deadline ? 'degrade' : 'wait';
        }
    }

    _releaseLock(held) {
        if (held) { try { fs.rmdirSync(this.lockPath); } catch {} }
    }

    /**
     * 同步跨进程文件锁，串行化"读-改-写"，防止并发写互相覆盖（lost update）。
     * 注意：自旋等待会同步阻塞事件循环 —— 只能用于短命的 hook 进程，长驻进程用 _withLockAsync。
     */
    _withLock(fn) {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        let held = false;
        for (;;) {
            const s = this._lockAttempt(deadline);
            if (s === 'held') { held = true; break; }
            if (s === 'degrade') break;
            sleepSync(LOCK_SPIN_MS);
        }
        try { return fn(); } finally { this._releaseLock(held); }
    }

    /** 异步版文件锁：等待时让出事件循环，不冻结长驻进程（feishu-listener 用） */
    async _withLockAsync(fn) {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        let held = false;
        for (;;) {
            const s = this._lockAttempt(deadline);
            if (s === 'held') { held = true; break; }
            if (s === 'degrade') break;
            await sleepAsync(LOCK_SPIN_MS);
        }
        try { return await fn(); } finally { this._releaseLock(held); }
    }

    /**
     * Reads JSON from disk into this.data.
     * Creates empty {} if file doesn't exist or is corrupted.
     * Returns this for chaining.
     */
    load() {
        try {
            const raw = fs.readFileSync(this.statePath, 'utf8');
            this.data = JSON.parse(raw);
        } catch (err) {
            // File doesn't exist, permission error, or JSON parse error
            this.data = {};
        }
        return this;
    }

    /**
     * Atomic write: write to .tmp file, then rename.
     * Prevents corruption from concurrent access.
     */
    save() {
        try {
            const json = JSON.stringify(this.data, null, 2);
            fs.writeFileSync(this.tmpPath, json, 'utf8');
            fs.renameSync(this.tmpPath, this.statePath);
        } catch (err) {
            // Log but don't crash — a write failure should not take down the process
            console.error('[session-state] Failed to save state:', err.message);
        }
    }

    /**
     * Adds a notification entry keyed by message ID or state key.
     * entry: { session_id, notification_type, pts_device, created_at, responses }
     *
     * Optimizations:
     * - Cleans stale Stop/StopFailure entries from the same terminal
     * - Caps total entries at MAX_ENTRIES (default 200)
     */
    _doAdd(messageId, entry) {
        this.load();
        this.data[messageId] = entry;
        // 上限保护：超过 200 条时删除最旧的
        const keys = Object.keys(this.data).filter((key) => key !== '__meta__');
        if (keys.length > 200) {
            const sorted = keys.sort((a, b) => (this.data[a].created_at || 0) - (this.data[b].created_at || 0));
            for (let i = 0; i < keys.length - 200; i++) delete this.data[sorted[i]];
        }
        this.save();
    }
    addNotification(messageId, entry) { this._withLock(() => this._doAdd(messageId, entry)); }
    addNotificationAsync(messageId, entry) { return this._withLockAsync(() => this._doAdd(messageId, entry)); }

    /**
     * 原子读改写：锁内 fresh load → mutator(this.data) → save。
     * mutator 返回 false 表示放弃保存（数据不变时省一次写盘）。
     *
     * 慢操作（网络请求等）必须放在锁外，只把「改自己键」的写回放进 mutator——
     * 用旧快照整表 save() 会把并发进程刚写入的通知清掉（飞书卡片随机「已失效」的根因）。
     */
    _doMutate(mutator) {
        this.load();
        const r = mutator(this.data);
        if (r !== false) this.save();
        return r;
    }
    mutate(mutator) { return this._withLock(() => this._doMutate(mutator)); }
    mutateAsync(mutator) { return this._withLockAsync(() => this._doMutate(mutator)); }

    /**
     * Returns the notification entry for a given message ID, or null.
     * Always loads fresh data from disk first.
     */
    getNotification(messageId) {
        this.load();
        return this.data[messageId] || null;
    }

    /**
     * Removes a notification entry and persists the change.
     */
    _doRemove(messageId) {
        this.load();
        delete this.data[messageId];
        this.save();
    }
    removeNotificationAsync(messageId) { return this._withLockAsync(() => this._doRemove(messageId)); }
    removeNotification(messageId) {
        this._withLock(() => {
            this.load();
            delete this.data[messageId];
            this.save();
        });
    }

    /**
     * 记录最近一次有效交互的终端设备（用于多终端路由）
     */
    _doSetLastDevice(ptsDevice) {
        this.load();
        // 合并而非覆盖 __meta__，避免冲掉 autoApproveDevices 等同级字段
        this.data['__meta__'] = { ...(this.data['__meta__'] || {}), lastInteractedDevice: ptsDevice, updated_at: Date.now() };
        this.save();
    }
    setLastInteractedDevice(ptsDevice) {
        if (!ptsDevice) return;
        this._withLock(() => this._doSetLastDevice(ptsDevice));
    }
    setLastInteractedDeviceAsync(ptsDevice) {
        if (!ptsDevice) return Promise.resolve();
        return this._withLockAsync(() => this._doSetLastDevice(ptsDevice));
    }

    /**
     * 获取指定终端的最新通知。
     */
    getLatestNotificationForDevice(ptsDevice) {
        this.load();
        let latestKey = null;
        let latestTime = -1;
        for (const [key, entry] of Object.entries(this.data)) {
            if (key === '__meta__') continue;
            if (entry.pts_device !== ptsDevice) continue;
            const createdAt = entry.created_at || 0;
            if (createdAt > latestTime) {
                latestTime = createdAt;
                latestKey = key;
            }
        }
        if (latestKey === null) return null;
        return { messageId: latestKey, ...this.data[latestKey] };
    }

    /**
     * Returns the most recent notification by created_at.
     * 优先返回最近一次有效交互的终端的通知，多终端场景下避免路由到错误终端。
     * Returns null if no notifications exist.
     */
    getLatestNotification() {
        this.load();

        // 优先按最近交互的终端路由
        const lastDevice = this.data['__meta__']?.lastInteractedDevice;
        if (lastDevice) {
            const deviceLatest = this.getLatestNotificationForDevice(lastDevice);
            if (deviceLatest) return deviceLatest;
        }

        // 默认取全局最新（排除 __meta__）
        let latestKey = null;
        let latestTime = -1;
        for (const [key, entry] of Object.entries(this.data)) {
            if (key === '__meta__') continue;
            const createdAt = entry.created_at || 0;
            if (createdAt > latestTime) {
                latestTime = createdAt;
                latestKey = key;
            }
        }
        if (latestKey === null) return null;
        return { messageId: latestKey, ...this.data[latestKey] };
    }

    /**
     * Removes entries older than maxAgeMs.
     * Default 12 hours, configurable via NOTIFICATION_EXPIRE_HOURS env var.
     */
    cleanExpired(maxAgeMs) {
        maxAgeMs = this._expiryMs(maxAgeMs);
        this._withLock(() => this._doCleanExpired(maxAgeMs));
    }

    cleanExpiredAsync(maxAgeMs) {
        return this._withLockAsync(() => this._doCleanExpired(this._expiryMs(maxAgeMs)));
    }

    _expiryMs(maxAgeMs) {
        if (maxAgeMs) return maxAgeMs;
        const hours = parseFloat(process.env.NOTIFICATION_EXPIRE_HOURS) || 12;
        return hours * 3600000;
    }

    _doCleanExpired(maxAgeMs) {
        this.load();
        const now = Date.now();
        let changed = false;
        for (const [key, entry] of Object.entries(this.data)) {
            if (key === '__meta__') continue;
            if (now - (entry.created_at || 0) > maxAgeMs) {
                delete this.data[key];
                changed = true;
            }
        }
        if (changed) this.save();
    }
}

const sessionStore = createSessionStore();
const cardStateStore = createCardStateStore();

module.exports = {
    SessionState,
    sessionState: new SessionState(),
    createSessionStore,
    createCardStateStore,
    sessionStore,
    cardStateStore,
};
