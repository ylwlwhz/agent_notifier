'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

require('../lib/env-config');

function resolveSessionsRoot({ codexHome = process.env.CODEX_HOME, home = process.env.HOME || '' } = {}) {
    const base = codexHome || path.join(home, '.codex');
    return path.join(base, 'sessions');
}

const SESSIONS_ROOT = resolveSessionsRoot();
const POLL_MS = 1000;
const TOOL_ICONS = {
    exec_command: '⚡',
};
const CODEX_CLI_PROCESS_PATTERN = /(^|[\s/])t?codex(?:$|[\s/.])/i;

function isCodexCliProcessArgs(args) {
    return CODEX_CLI_PROCESS_PATTERN.test(String(args || ''));
}

function extractLastTokenUsage(payload) {
    const usage = payload?.info?.last_token_usage;
    if (!usage || typeof usage !== 'object') return null;
    const input = Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null;
    const cached = Number.isFinite(Number(usage.cached_input_tokens)) ? Number(usage.cached_input_tokens) : null;
    const output = Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null;
    const total = Number.isFinite(Number(usage.total_tokens)) ? Number(usage.total_tokens) : null;
    if (input == null && cached == null && output == null && total == null) return null;
    return { input, cached, output, total };
}

function parseSessionLine(line, state = { turnId: '' }) {
    const nextState = {
        ...state,
        callMap: { ...(state.callMap || {}) },
    };
    const raw = String(line || '').trim();
    if (!raw) {
        return { state: nextState, entry: null };
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return { state: nextState, entry: null };
    }

    if (data.type === 'turn_context' && data.payload?.turn_id) {
        nextState.turnId = String(data.payload.turn_id);
        return { state: nextState, entry: null };
    }

    if (data.type === 'event_msg' && data.payload?.type === 'task_started' && data.payload?.turn_id) {
        nextState.turnId = String(data.payload.turn_id);
        nextState.turnStartedAt = data.timestamp || nextState.turnStartedAt || null;
        nextState.callMap = {};
        return { state: nextState, entry: null };
    }

    if (data.type === 'event_msg' && data.payload?.type === 'token_count') {
        nextState.tokens = extractLastTokenUsage(data.payload);
        return { state: nextState, entry: null };
    }

    if (data.type !== 'response_item') {
        if (data.type === 'event_msg' && data.payload?.turn_id) {
            nextState.turnId = String(data.payload.turn_id);
        }
        return { state: nextState, entry: null };
    }

    const payload = data.payload || {};
    if (payload.turn_id) {
        nextState.turnId = String(payload.turn_id);
    }

    if (payload.type === 'function_call') {
        const tool = String(payload.name || '').trim() || 'tool_call';
        const input = summarizeCallInput(tool, payload.arguments);
        const callId = String(payload.call_id || '').trim();
        if (callId) {
            nextState.callMap[callId] = {
                name: tool,
                input,
            };
        }
        return {
            state: nextState,
            entry: {
                assistantKey: nextState.turnId || callId || tool,
                tool,
                icon: TOOL_ICONS[tool] || '🔧',
                input,
                result: null,
                phase: payload.phase || null,
                turnStartedAt: nextState.turnStartedAt || null,
                tokens: nextState.tokens || null,
            },
        };
    }

    if (payload.type === 'function_call_output') {
        const callId = String(payload.call_id || '').trim();
        const known = callId ? nextState.callMap[callId] : null;
        if (callId && known) {
            delete nextState.callMap[callId];
        }
        const tool = known?.name || 'tool_output';
        return {
            state: nextState,
            entry: {
                assistantKey: nextState.turnId || callId || tool,
                tool,
                icon: TOOL_ICONS[tool] || '🔧',
                input: known?.input || null,
                result: summarizeCallOutput(payload.output),
                phase: payload.phase || null,
                turnStartedAt: nextState.turnStartedAt || null,
                tokens: nextState.tokens || null,
            },
        };
    }

    if (payload.type !== 'message' || payload.role !== 'assistant') {
        return { state: nextState, entry: null };
    }

    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const text = blocks
        .filter((block) => block?.type === 'output_text' && String(block.text || '').trim())
        .map((block) => String(block.text).trim())
        .join('\n')
        .trim();
    if (!text) {
        return { state: nextState, entry: null };
    }

    return {
        state: nextState,
        entry: {
            text,
            assistantKey: nextState.turnId || text.slice(0, 80),
            icon: '💬',
            phase: payload.phase || null,
            turnStartedAt: nextState.turnStartedAt || null,
            tokens: nextState.tokens || null,
        },
    };
}

function safeParseJson(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function truncateLine(text, max = 160) {
    const line = String(text || '').trim();
    if (!line) return null;
    if (line.length <= max) return line;
    return `${line.slice(0, max)}…`;
}

function summarizeCallInput(name, rawArguments) {
    const parsed = (typeof rawArguments === 'object' && rawArguments !== null)
        ? rawArguments
        : safeParseJson(rawArguments);
    if (name === 'exec_command') {
        const cmd = parsed?.cmd || parsed?.command;
        if (cmd) return truncateLine(cmd, 200);
    }
    if (parsed && typeof parsed === 'object') {
        return truncateLine(JSON.stringify(parsed), 200);
    }
    return truncateLine(rawArguments, 200);
}

function summarizeCallOutput(rawOutput) {
    if (rawOutput == null) return null;

    if (typeof rawOutput === 'object') {
        if (Number.isFinite(Number(rawOutput.exit_code))) {
            return `退出码 ${Number(rawOutput.exit_code)}`;
        }
        return truncateLine(JSON.stringify(rawOutput), 160);
    }

    const text = String(rawOutput);
    const codeMatch = text.match(/Process exited with code (\d+)/i);
    if (codeMatch) {
        return `退出码 ${codeMatch[1]}`;
    }

    const line = text
        .split('\n')
        .map((item) => item.trim())
        .find((item) => item.length > 0);
    return truncateLine(line, 160);
}

function recoverStateFromContent(content) {
    let state = { turnId: '', callMap: {} };
    const lines = String(content || '').split('\n').filter(Boolean);
    for (const line of lines) {
        state = parseSessionLine(line, state).state;
    }
    return state;
}

function findLatestSessionFile(rootDir = SESSIONS_ROOT) {
    let latestPath = null;
    let latestMtime = -1;

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }
            let stat;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                continue;
            }
            if (stat.mtimeMs > latestMtime) {
                latestMtime = stat.mtimeMs;
                latestPath = fullPath;
            }
        }
    }

    walk(rootDir);
    return latestPath;
}

function parseSessionMetaFromFile(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const len = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (len <= 0) return null;
        const firstLine = buf.toString('utf8', 0, len).split('\n').find(Boolean);
        if (!firstLine) return null;
        const row = JSON.parse(firstLine);
        if (row?.type !== 'session_meta') return null;
        const cwd = row?.payload?.cwd ? String(row.payload.cwd) : null;
        const timestampRaw = row?.payload?.timestamp || row?.timestamp || null;
        const timestampMs = timestampRaw ? Date.parse(timestampRaw) : NaN;
        return {
            cwd,
            timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
        };
    } catch {
        return null;
    }
}

function collectSessionCandidates(rootDir = SESSIONS_ROOT) {
    const candidates = [];

    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            let stat;
            try {
                stat = fs.statSync(fullPath);
            } catch {
                continue;
            }
            candidates.push({
                path: fullPath,
                mtimeMs: stat.mtimeMs || 0,
                meta: parseSessionMetaFromFile(fullPath),
            });
        }
    }

    walk(rootDir);
    return candidates;
}

function readCodexProcessForPts(pts) {
    const targetTty = `pts/${pts}`;
    try {
        const out = execSync('ps -eo pid=,tty=,etimes=,args=', {
            encoding: 'utf8',
            timeout: 2000,
        });
        const rows = out.split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const m = line.match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
                if (!m) return null;
                return {
                    pid: Number(m[1]),
                    tty: m[2],
                    elapsedSec: Number(m[3]),
                    args: m[4],
                };
            })
            .filter(Boolean)
            .filter((row) =>
                row.tty === targetTty &&
                isCodexCliProcessArgs(row.args) &&
                !/pty-relay\.py/i.test(row.args) &&
                !/codex-session-watcher\.js/i.test(row.args)
            )
            .sort((a, b) => a.elapsedSec - b.elapsedSec);

        const proc = rows[0];
        if (!proc) return null;
        let cwd = null;
        try {
            cwd = fs.readlinkSync(`/proc/${proc.pid}/cwd`);
        } catch {}
        return {
            pid: proc.pid,
            cwd,
            processStartMs: Date.now() - (proc.elapsedSec * 1000),
        };
    } catch {
        return null;
    }
}

function selectSessionCandidate(candidates, processInfo) {
    const all = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!all.length) return null;

    const sortedByMtime = [...all].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    if (!processInfo) return sortedByMtime[0] || null;

    const targetCwd = processInfo.cwd ? String(processInfo.cwd) : null;
    const targetStart = Number(processInfo.processStartMs);

    const scored = all.map((item) => {
        const sameCwd = !!(targetCwd && item.meta?.cwd && item.meta.cwd === targetCwd);
        const ts = item.meta?.timestampMs;
        let timeDelta = Number.POSITIVE_INFINITY;
        if (Number.isFinite(targetStart) && Number.isFinite(ts)) {
            timeDelta = Math.abs(ts - targetStart);
        }
        return { item, sameCwd, timeDelta };
    });

    const cwdMatches = scored.filter((s) => s.sameCwd);
    if (cwdMatches.length > 0) {
        cwdMatches.sort((a, b) => {
            if (a.timeDelta !== b.timeDelta) return a.timeDelta - b.timeDelta;
            return (b.item.mtimeMs || 0) - (a.item.mtimeMs || 0);
        });
        return cwdMatches[0].item;
    }

    const withMetaTime = scored.filter((s) => Number.isFinite(s.timeDelta));
    if (withMetaTime.length > 0) {
        withMetaTime.sort((a, b) => {
            if (a.timeDelta !== b.timeDelta) return a.timeDelta - b.timeDelta;
            return (b.item.mtimeMs || 0) - (a.item.mtimeMs || 0);
        });
        return withMetaTime[0].item;
    }

    return sortedByMtime[0] || null;
}

function resolveSessionFileForPts(pts, rootDir = SESSIONS_ROOT) {
    const candidates = collectSessionCandidates(rootDir);
    const processInfo = readCodexProcessForPts(pts);
    const selected = selectSessionCandidate(candidates, processInfo);
    return selected?.path || null;
}

class CodexSessionWatcher {
    constructor({ pts, installDir, projectName, liveBufferPath }) {
        this.pts = pts;
        this.installDir = installDir;
        this.projectName = projectName;
        this.liveBufferPath = liveBufferPath;
        this.currentFile = null;
        this.offset = 0;
        this.state = { turnId: '', callMap: {} };
        this.started = false;
    }

    tick() {
        const targetFile = this.currentFile && fs.existsSync(this.currentFile)
            ? this.currentFile
            : resolveSessionFileForPts(this.pts);
        if (!targetFile) return;

        if (targetFile !== this.currentFile) {
            this.currentFile = targetFile;
            this.offset = 0;
            this.state = { turnId: '', callMap: {} };
            try {
                const stat = fs.statSync(targetFile);
                const readSize = Math.min(stat.size, 65536);
                if (readSize > 0) {
                    const fd = fs.openSync(targetFile, 'r');
                    const buf = Buffer.alloc(readSize);
                    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
                    fs.closeSync(fd);
                    this.state = recoverStateFromContent(buf.toString('utf8'));
                }
                this.offset = stat.size;
            } catch {
                this.offset = 0;
            }
            if (!this.started) {
                this.started = true;
            }
            return;
        }

        let stat;
        try {
            stat = fs.statSync(targetFile);
        } catch {
            return;
        }
        if (stat.size <= this.offset) return;

        const fd = fs.openSync(targetFile, 'r');
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        fs.closeSync(fd);
        this.offset = stat.size;

        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            const parsed = parseSessionLine(line, this.state);
            this.state = parsed.state;
            if (!parsed.entry) continue;
            this.emitEntry(parsed.entry);
        }
    }

    emitEntry(entry) {
        const payload = {
            kind: 'output',
            assistant_key: entry.assistantKey,
            project_name: this.projectName,
            pts_device: `/dev/pts/${this.pts}`,
            ts: Date.now(),
            phase: entry.phase,
            turn_started_at: entry.turnStartedAt || null,
            tokens: entry.tokens || null,
        };

        if (entry.text) payload.text = entry.text;
        if (entry.tool) payload.tool = entry.tool;
        if (entry.icon) payload.icon = entry.icon;
        if (entry.input) payload.input = entry.input;
        if (entry.result) payload.result = entry.result;

        fs.appendFileSync(this.liveBufferPath, JSON.stringify(payload) + '\n', 'utf8');

        const child = spawn('node', [
            path.join(this.installDir, 'src/apps/codex-live.js'),
            '--flush',
            this.liveBufferPath,
        ], {
            cwd: this.installDir,
            env: process.env,
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }

    start() {
        this.tick();
        setInterval(() => this.tick(), POLL_MS);
    }
}

function main() {
    const ptsIdx = process.argv.indexOf('--pts');
    const pts = ptsIdx >= 0 ? process.argv[ptsIdx + 1] : null;
    if (!pts) {
        throw new Error('需要 --pts');
    }
    const installDir = path.resolve(__dirname, '..', '..');
    const watcher = new CodexSessionWatcher({
        pts,
        installDir,
        projectName: path.basename(process.cwd()),
        liveBufferPath: `/tmp/codex-live-${pts}.jsonl`,
    });
    watcher.start();
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error('[codex-session-watcher] 启动失败:', err.message);
        process.exit(1);
    }
}

module.exports = {
    parseSessionLine,
    recoverStateFromContent,
    findLatestSessionFile,
    selectSessionCandidate,
    resolveSessionFileForPts,
    resolveSessionsRoot,
    isCodexCliProcessArgs,
    CodexSessionWatcher,
    extractLastTokenUsage,
};
