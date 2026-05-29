'use strict';

// 会话统计公共件（成本/时长，与状态栏同源）：claude-hook（Stop 卡）与 completion-card（ccback 卡）共用。

const fs = require('fs');

/** 时长 ms → 紧凑串（不到 1 分钟才显示秒，否则秒无意义） */
function fmtDuration(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m` : `${s}s`;
}

/** 读 cost-capture.js 落盘的官方成本/时长；文件按完整 session_id 命名，多窗口互不干扰，无则 null */
function readOfficialStats(sessionId) {
    if (!sessionId) return null;
    try {
        const j = JSON.parse(fs.readFileSync(`/tmp/claude-cost-${sessionId}.json`, 'utf8'));
        return {
            costUSD: typeof j.cost === 'number' ? j.cost : null,
            duration: typeof j.durationMs === 'number' ? fmtDuration(j.durationMs) : '',
            contextPct: j.contextPct,
            sessionName: j.sessionName,
        };
    } catch { return null; }
}

module.exports = { fmtDuration, readOfficialStats };
