#!/usr/bin/env node
'use strict';

/**
 * statusLine 旁路：读 Claude Code 的 statusLine payload，
 *   1）把限额窗口内的消耗算好塞回 payload，交给下游的 statusline.sh 渲染；
 *   2）把成本/上下文/限额等字段落盘到 /tmp/claude-cost-<session_id>.json，供 Stop hook 读取。
 *
 * hook 的输入不含 cost 与 rate_limits，只有 statusLine 的输入有（客户端实时计算）。
 * 把它接在 statusLine 命令最前面即可，例：
 *   node .../cost-capture.js | ~/.claude/statusline.sh
 *
 * 并发：每个会话 session_id 唯一 → 各写各的文件，多窗口互不干扰；
 * temp+rename 原子替换，避免 hook 读到正在写的半截 JSON。
 */

const fs = require('fs');
const { windowCosts } = require('../lib/usage-window');

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
    let j = null;
    try { j = JSON.parse(data); } catch {}

    // 消耗统计塞进 payload 再透传。算不出来（transcript 读不到等）就原样透传，
    // 下游 statusline.sh 见不到这个字段会自动少渲染一行，绝不会整条状态栏挂掉。
    let out = data;
    let usage = null;
    if (j) {
        usage = windowCosts(j.rate_limits);
        if (usage) {
            try {
                j.agent_notifier = Object.assign({}, j.agent_notifier, { usage });
                out = JSON.stringify(j);
            } catch { out = data; }
        }
    }
    process.stdout.write(out);

    try {
        if (j && j.session_id && j.cost) {
            const file = `/tmp/claude-cost-${j.session_id}.json`;
            const tmp = `${file}.${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify({
                cost: j.cost.total_cost_usd,
                durationMs: j.cost.total_duration_ms,
                contextPct: j.context_window?.used_percentage,
                sessionName: j.session_name,
                rateLimits: j.rate_limits,   // 卡片上的限额标签只能从这里拿：hook 的 payload 没有
                usage,
                ts: Date.now(),
            }));
            fs.renameSync(tmp, file);
        }
    } catch {}
});
