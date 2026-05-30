#!/usr/bin/env node
'use strict';

/**
 * statusLine 收尾：把 ccusage 那个「本地重算」的 5h 倒计时换成 Claude Code 官方真实重置时间。
 *
 * ccusage 的 (Xh Ym left) = floor(本窗口首条消息→整点) + 5h - now，取整就会偏（实测 ~50min）。
 * 而 statusLine 的 JSON 本就带官方 rate_limits.five_hour.resets_at（+已用%），由 cost-capture.js
 * 按 ppid 落到 /tmp/claude-sl-<ppid>.json（同管道两 node 共享父 shell，故 ppid 相同）。
 *
 *   用法：node cost-capture.js | ccusage statusline | node statusline-fix.js
 *   降级：官方数据缺失（子会话等）时原样保留 ccusage 段，绝不让状态栏变空。
 */

const fs = require('fs');

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
    // 1. 去掉 ccusage 的 "🤖 <model> | " 前缀
    let line = data.replace(/^🤖 [^|]*\| /, '');

    // 2. 读官方 5h 重置，拼成展示段
    let seg = null;
    try {
        const f = `/tmp/claude-sl-${process.ppid}.json`;
        const m = JSON.parse(fs.readFileSync(f, 'utf8'));
        fs.unlinkSync(f); // 读完即删，避免 /tmp 堆积
        const left = Math.max(0, Math.round((m.resetsAt * 1000 - Date.now()) / 60000));
        const t = left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m` : `${left}m`;
        seg = `⏳ ${t}` + (m.pct != null ? ` (${Math.round(m.pct)}%)` : '');
    } catch {}

    // 3. 有官方数据才动刀：去掉 block 段，把官方 5h 段插到 🔥 之前；否则原样保留
    if (seg) {
        line = line.replace(/ \/ \$[\d.]+ block \([^)]*\)/, '');
        line = / \| 🔥/.test(line)
            ? line.replace(/ \| 🔥/, ` | ${seg} | 🔥`)
            : line.replace(/\n?$/, ` | ${seg}\n`);
    }

    process.stdout.write(line);
});
