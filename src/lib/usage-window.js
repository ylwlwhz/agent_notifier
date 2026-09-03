'use strict';

/**
 * 按「限额窗口」统计 Claude 的美元消耗，跨全部会话。
 *
 * 为什么不用 ccusage：它只会按【自己划的 5 小时块】和【自然日/自然周】聚合，块的起点
 * 是「首条消息所在整点」，跟 Claude 真正的额度重置点没有关系——状态栏第三行写着
 * 「5h 37% ⟳2h11m」，第二行却在报一个起点完全不同的 5 小时窗口，两行对不上。
 * 这里直接用 statusLine payload 里的 rate_limits.resets_at 反推窗口起点，
 * 两行说的就是同一段时间。
 *
 * 数据源与 ccusage 相同：~/.claude/projects/**\/*.jsonl 里的 assistant 记录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sharedTmpPath } = require('./tmp-dir');

// ── 定价 ─────────────────────────────────────────────────
//
// Anthropic 的价目表里，同一个模型的五档单价是锁死的固定比例：
//   output = 5×input，cache write 5m = 1.25×input，cache write 1h = 2×input，
//   cache read = 0.1×input
// 所以每个模型只需要记一个 input 基准价。已用真实 transcript 与 ccusage 对账：
// claude-opus-5 与 claude-fable-5 逐日成本分毫不差（如 2026-09-01 的 6.944960 /
// 6.190953、2026-08-30 的 12.062892），比例与基准价都验证过。
//
// 按【模型系列前缀】匹配而不是完整型号：Claude 每出一个小版本，写死型号的表就会漏掉，
// 漏掉的模型会被整段算成 0 元——ccusage 20.0.20 至今仍把 claude-fable-5-1 算成 $0，
// 就是这么来的。前缀匹配下 opus-6 / fable-5-2 这类新版本自动落到对应系列。
const INPUT_PRICE = [
    [/^claude-3-5-haiku/, 0.8e-6],
    [/^claude-3-haiku/, 0.25e-6],
    [/^claude-3-opus/, 15e-6],
    [/^claude-3[.-]/, 3e-6],          // 3.x sonnet 系列
    [/^claude-fable/, 10e-6],
    [/^claude-opus/, 5e-6],
    [/^claude-sonnet/, 3e-6],
    [/^claude-haiku/, 1e-6],
];
// 认不出的 claude-* 一律按 Opus 档估：宁可高估也别像 ccusage 那样默默算成 0——
// 状态栏上「今天只花了 $0」比「贵了一点」误导得多。
const FALLBACK_INPUT_PRICE = 5e-6;

function inputPrice(model) {
    if (!model || model === '<synthetic>') return 0;
    for (const [re, p] of INPUT_PRICE) if (re.test(model)) return p;
    return /^claude/.test(model) ? FALLBACK_INPUT_PRICE : 0;
}

function entryCost(usage, model) {
    const p = inputPrice(model);
    if (!p) return 0;
    const cc = usage.cache_creation || {};
    const e5 = cc.ephemeral_5m_input_tokens || 0;
    const e1 = cc.ephemeral_1h_input_tokens || 0;
    // 旧记录没有 cache_creation 细分，只有汇总字段，按 5m 计（Claude Code 早期只用 5m）
    const legacy = (e5 || e1) ? 0 : (usage.cache_creation_input_tokens || 0);
    return p * (
        (usage.input_tokens || 0)
        + 5 * (usage.output_tokens || 0)
        + 1.25 * (e5 + legacy)
        + 2 * e1
        + 0.1 * (usage.cache_read_input_tokens || 0)
    );
}

// ── transcript 扫描 ──────────────────────────────────────

function transcriptRoots() {
    const dirs = [];
    const cfg = process.env.CLAUDE_CONFIG_DIR;
    if (cfg) {
        for (const d of cfg.split(path.delimiter)) if (d) dirs.push(path.join(d, 'projects'));
    } else {
        dirs.push(path.join(os.homedir(), '.claude', 'projects'));
        dirs.push(path.join(os.homedir(), '.config', 'claude', 'projects'));
    }
    return dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

function listJsonl(dir, out) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listJsonl(p, out);          // subagents/ 子目录里的 agent-*.jsonl 也算
        else if (e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
}

/**
 * 把一段 JSONL 文本里的 assistant 记录喂给 byId，返回其中最早的时间戳（没有则 null）。
 *
 * 去重键取 message.id，且【后写的覆盖先写的】：Claude Code 会为同一条 assistant 消息的
 * 每个 content block（思考、正文、每个 tool_use）各写一行，行与行共享 message.id，
 * 而 usage.output_tokens 是写这一行时的累计快照——只认第一行会把输出 token 少算几倍
 * （实测某天 109420 vs 350980）。取最后一行才等于这条消息的最终用量，与 ccusage 一致。
 * 覆盖写也让「读多了重复扫一遍」变成幂等操作，下面的扩读循环因此不必去算重叠区间。
 */
function feedLines(text, byId) {
    let earliest = null;
    for (const line of text.split('\n')) {
        if (line.indexOf('"usage"') < 0) continue;      // 绝大多数行是 user/tool_result，先挡掉再 JSON.parse
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d.type !== 'assistant') continue;
        const m = d.message;
        if (!m || !m.usage) continue;
        const t = Date.parse(d.timestamp);
        if (!Number.isFinite(t)) continue;
        if (earliest === null || t < earliest) earliest = t;
        byId.set(m.id || d.uuid, { t, cost: entryCost(m.usage, m.model) });
    }
    return earliest;
}

const TAIL_START = 1 << 20;   // 先读末尾 1MB
const TAIL_GROW = 4;
const TAIL_MAX = 128 << 20;

/**
 * 从文件末尾往前读，直到读到窗口起点之前的记录为止。
 *
 * 单个 transcript 能长到几十 MB（实测 58MB），但 7 天窗口往往只占它末尾很小一段；
 * 整份读进来纯属浪费——状态栏是每次事件都要渲染的东西，慢渲染会被 Claude 掐掉。
 * JSONL 按时间递增追加，所以「本段最早一条已经早于窗口起点」就等于前面全都不用看了。
 */
function scanTail(file, sinceMs, byId) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
        const size = fs.fstatSync(fd).size;
        for (let span = TAIL_START; ; span *= TAIL_GROW) {
            const start = Math.max(0, size - span);
            const len = size - start;
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, start);
            let text = buf.toString('utf8');
            if (start > 0) {
                const nl = text.indexOf('\n');       // 首行被切断了，丢掉
                text = nl < 0 ? '' : text.slice(nl + 1);
            }
            const earliest = feedLines(text, byId);
            if (start === 0 || span >= TAIL_MAX) return;
            if (earliest !== null && earliest < sinceMs) return;
        }
    } catch {
        /* 文件读坏了就当它没有，绝不让状态栏因为一份 transcript 整个失败 */
    } finally {
        try { fs.closeSync(fd); } catch {}
    }
}

/**
 * @param {Array<{key: string, sinceMs: number}>} windows
 * @returns {Object<string, number>} 每个窗口内的美元消耗
 */
function scanWindows(windows) {
    const oldest = Math.min(...windows.map(w => w.sinceMs));
    const byId = new Map();
    for (const root of transcriptRoots()) {
        for (const f of listJsonl(root, [])) {
            // mtime 早于窗口起点 = 这份 transcript 在窗口内一个字都没写过
            let st;
            try { st = fs.statSync(f); } catch { continue; }
            if (st.mtimeMs < oldest) continue;
            scanTail(f, oldest, byId);
        }
    }
    const out = {};
    for (const w of windows) out[w.key] = 0;
    for (const { t, cost } of byId.values()) {
        for (const w of windows) if (t >= w.sinceMs) out[w.key] += cost;
    }
    return out;
}

// ── 窗口定义与缓存 ───────────────────────────────────────

// rate_limits 的档位 → 窗口长度。Claude 只在 payload 里给重置时刻，不给窗口长度，
// 认不出的档位（将来可能出现的 Opus/Sonnet 分档）就不参与本行统计。
const WINDOW_MS = {
    five_hour: 5 * 3600e3,
    seven_day: 7 * 86400e3,
};

const CACHE_FILE = sharedTmpPath('claude-usage-window.json');
const CACHE_TTL_MS = 8000;   // 状态栏 refreshInterval 是 30s，但事件驱动的重绘会密集得多

function windowsFrom(rateLimits, now) {
    const windows = [];
    for (const [key, span] of Object.entries(WINDOW_MS)) {
        const resetsAt = rateLimits && rateLimits[key] && rateLimits[key].resets_at;
        // 没有 rate_limits（API key 模式、本次会话还没发过请求）或重置时刻已过期时，
        // 退化成「截至此刻的滚动窗口」：起点跟额度重置对不齐，但总比整行消失强。
        const end = Number.isFinite(resetsAt) && resetsAt * 1000 > now ? resetsAt * 1000 : now;
        windows.push({ key, sinceMs: end - span });
    }
    return windows;
}

function readCache(windows, now) {
    try {
        const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (now - c.ts > CACHE_TTL_MS || now < c.ts) return null;
        if (windows.some(w => c.since[w.key] !== w.sinceMs)) return null;   // 刚过重置点，旧值作废
        return c.costs;
    } catch { return null; }
}

function writeCache(windows, costs, now) {
    const since = {};
    for (const w of windows) since[w.key] = w.sinceMs;
    try {
        const tmp = `${CACHE_FILE}.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ ts: now, since, costs }));
        fs.renameSync(tmp, CACHE_FILE);
    } catch {}
}

/**
 * 计算各限额窗口内的消耗。
 *
 * @param {Object|null} rateLimits statusLine payload 的 .rate_limits
 * @returns {Object<string, number>|null} 如 { five_hour: 12.3, seven_day: 210.5 }；失败返回 null
 */
function windowCosts(rateLimits) {
    try {
        const now = Date.now();
        const windows = windowsFrom(rateLimits, now);
        const cached = readCache(windows, now);
        if (cached) return cached;
        const costs = scanWindows(windows);
        writeCache(windows, costs, now);
        return costs;
    } catch {
        return null;
    }
}

module.exports = { windowCosts, scanWindows, entryCost, inputPrice };
