const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanWindows, entryCost, inputPrice } = require('../../src/lib/usage-window');

// scanWindows 从 CLAUDE_CONFIG_DIR/projects 读 transcript，测试里指到临时目录
function withProjects(build) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-window-'));
    const projects = path.join(root, 'projects');
    fs.mkdirSync(projects, { recursive: true });
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try { return build(projects); }
    finally {
        if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prev;
    }
}

function assistantLine({ id, ts, model = 'claude-opus-5', out = 0, input = 0, read = 0, write1h = 0, filler = 0 }) {
    return JSON.stringify({
        type: 'assistant',
        uuid: `${id}-${ts}`,
        timestamp: new Date(ts).toISOString(),
        filler: 'x'.repeat(filler),
        message: {
            id,
            model,
            usage: {
                input_tokens: input,
                output_tokens: out,
                cache_read_input_tokens: read,
                cache_creation_input_tokens: write1h,
                cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write1h },
            },
        },
    });
}

test('定价按模型系列前缀匹配，认不出的 claude-* 退到 Opus 档而不是算成 0', () => {
    assert.equal(inputPrice('claude-opus-5'), 5e-6);
    assert.equal(inputPrice('claude-opus-4-8'), 5e-6);
    assert.equal(inputPrice('claude-fable-5'), 10e-6);
    assert.equal(inputPrice('claude-fable-5-1'), 10e-6, '新小版本不该像 ccusage 那样掉成 0');
    assert.equal(inputPrice('claude-sonnet-5'), 3e-6);
    assert.equal(inputPrice('claude-haiku-4-5'), 1e-6);
    assert.equal(inputPrice('claude-3-5-haiku-20241022'), 0.8e-6);
    assert.equal(inputPrice('claude-3-opus-20240229'), 15e-6);
    assert.equal(inputPrice('claude-opus-99'), 5e-6, '将来的型号也落在 Opus 档');
    assert.equal(inputPrice('<synthetic>'), 0);
    assert.equal(inputPrice('gpt-5'), 0);
    assert.equal(inputPrice(undefined), 0);
});

test('单条成本与 Anthropic 价目表一致（用 2026-09-01 的真实 opus-5 用量对账）', () => {
    // 该日 ccusage 报 6.944960，逐 token 类型算出来应当分毫不差
    const cost = entryCost({
        input_tokens: 74,
        output_tokens: 85781,
        cache_read_input_tokens: 5764090,
        cache_creation_input_tokens: 191802,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 191802 },
    }, 'claude-opus-5');
    assert.ok(Math.abs(cost - 6.94496) < 1e-6, `期望 6.94496，实得 ${cost}`);
});

test('没有 cache_creation 细分的旧记录按 5m 档计价', () => {
    const legacy = entryCost({ cache_creation_input_tokens: 1e6 }, 'claude-opus-5');
    assert.ok(Math.abs(legacy - 1.25 * 5e-6 * 1e6) < 1e-9, `期望 6.25，实得 ${legacy}`);
    const split = entryCost({
        cache_creation_input_tokens: 1e6,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 },
    }, 'claude-opus-5');
    assert.ok(Math.abs(split - 2 * 5e-6 * 1e6) < 1e-9, `细分字段在时以细分为准，1h 是 2 倍不是 1.25 倍，实得 ${split}`);
});

test('只统计窗口内的记录，窗口外的一分不算', () => {
    const now = Date.now();
    const costs = withProjects((projects) => {
        const proj = path.join(projects, '-demo');
        fs.mkdirSync(proj);
        fs.writeFileSync(path.join(proj, 's.jsonl'), [
            assistantLine({ id: 'old', ts: now - 6 * 3600e3, out: 1e6 }),   // 5h 窗口外、7d 窗口内
            assistantLine({ id: 'new', ts: now - 600e3, out: 1e6 }),        // 两个窗口都在
        ].join('\n') + '\n');
        return scanWindows([
            { key: 'five_hour', sinceMs: now - 5 * 3600e3 },
            { key: 'seven_day', sinceMs: now - 7 * 86400e3 },
        ]);
    });
    const one = 5 * 25e-6 * 1e6 / 5;   // 1e6 output @ $25/Mtok
    assert.ok(Math.abs(costs.five_hour - one) < 1e-9, `5h 只该算新的一条，实得 ${costs.five_hour}`);
    assert.ok(Math.abs(costs.seven_day - 2 * one) < 1e-9, `7d 两条都算，实得 ${costs.seven_day}`);
});

test('同一 message.id 的多行取最后一行：output_tokens 是累计快照，取第一行会少算', () => {
    const now = Date.now();
    const costs = withProjects((projects) => {
        const proj = path.join(projects, '-demo');
        fs.mkdirSync(proj);
        // Claude Code 为同一条 assistant 消息的每个 content block 各写一行，共享 message.id
        fs.writeFileSync(path.join(proj, 's.jsonl'), [
            assistantLine({ id: 'm1', ts: now - 300e3, out: 7 }),
            assistantLine({ id: 'm1', ts: now - 290e3, out: 4000 }),
            assistantLine({ id: 'm1', ts: now - 280e3, out: 1e6 }),
        ].join('\n') + '\n');
        return scanWindows([{ key: 'five_hour', sinceMs: now - 5 * 3600e3 }]);
    });
    assert.ok(Math.abs(costs.five_hour - 25e-6 * 1e6) < 1e-9, `该按最后一行的 1e6 算，实得 ${costs.five_hour}`);
});

test('子目录里的 subagents/agent-*.jsonl 一并统计', () => {
    const now = Date.now();
    const costs = withProjects((projects) => {
        const sub = path.join(projects, '-demo', 's', 'subagents');
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(projects, '-demo', 's.jsonl'), assistantLine({ id: 'main', ts: now - 60e3, out: 1e6 }) + '\n');
        fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), assistantLine({ id: 'sub', ts: now - 60e3, out: 1e6 }) + '\n');
        return scanWindows([{ key: 'five_hour', sinceMs: now - 5 * 3600e3 }]);
    });
    assert.ok(Math.abs(costs.five_hour - 2 * 25e-6 * 1e6) < 1e-9, `主会话 + 子代理都要算，实得 ${costs.five_hour}`);
});

test('尾部扩读：窗口内容超过首次读取的 1MB 时会继续往前读，窗口外的头部不会被读进来', () => {
    const now = Date.now();
    const costs = withProjects((projects) => {
        const proj = path.join(projects, '-demo');
        fs.mkdirSync(proj);
        const lines = [];
        // 头部：2MB 的窗口外记录，扩读必须在这里停住
        for (let i = 0; i < 300; i++) {
            lines.push(assistantLine({ id: `old${i}`, ts: now - 30 * 86400e3 + i * 1000, out: 1e6, filler: 7000 }));
        }
        // 尾部：约 1.4MB 的窗口内记录，一次 1MB 的尾读盖不全，必须扩读
        for (let i = 0; i < 200; i++) {
            lines.push(assistantLine({ id: `new${i}`, ts: now - 3600e3 + i * 1000, out: 1000, filler: 7000 }));
        }
        const file = path.join(proj, 's.jsonl');
        fs.writeFileSync(file, lines.join('\n') + '\n');
        assert.ok(fs.statSync(file).size > 3e6, '构造的文件要大于 3MB 才能压到扩读逻辑');
        return scanWindows([{ key: 'five_hour', sinceMs: now - 5 * 3600e3 }]);
    });
    assert.ok(Math.abs(costs.five_hour - 200 * 25e-6 * 1000) < 1e-9, `只该算尾部 200 条，实得 ${costs.five_hour}`);
});

test('mtime 早于窗口起点的 transcript 整份跳过', () => {
    const now = Date.now();
    const costs = withProjects((projects) => {
        const proj = path.join(projects, '-demo');
        fs.mkdirSync(proj);
        const file = path.join(proj, 'stale.jsonl');
        fs.writeFileSync(file, assistantLine({ id: 'x', ts: now - 60e3, out: 1e6 }) + '\n');
        const old = (now - 30 * 86400e3) / 1000;
        fs.utimesSync(file, old, old);
        return scanWindows([{ key: 'five_hour', sinceMs: now - 5 * 3600e3 }]);
    });
    assert.equal(costs.five_hour, 0, '窗口内一个字都没写过的文件不该被读');
});
