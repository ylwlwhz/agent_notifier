'use strict';

/**
 * 对话名称 —— Cursor 不给，只能自己从 transcript 里取第一条用户消息。
 *
 * 2026-09-04 在 Cursor 3.17.19 上挂探针抓了真实 payload，字段就这些：
 * `conversation_id`、`generation_id`、`model`、`tool_name`、`tool_input`、`tool_output`、
 * `duration`、`tool_use_id`、`cwd`、`session_id`、`hook_event_name`、`cursor_version`、
 * `workspace_roots`、`user_email`、`transcript_path` —— **没有任何名称/标题字段**。
 * 侧边栏那个标题是 IDE 客户端自己生成、存在本机工作区状态里的；Remote-SSH 时
 * hook 跑在远程机上，那份状态根本不在同一台机器，读不到。
 *
 * 所以拿第一条用户消息当名字：Cursor 自己也是照它起标题的，而且它对一个会话恒定不变，
 * 正好符合「名字」该有的语义（不像 generation_id 每轮都换）。
 */

const fs = require('fs');
const { sharedTmpPath } = require('../../lib/tmp-dir');

// transcript 动辄几 MB，只为第一行读全文太浪费；64KB 足够容纳第一条用户消息
const HEAD_BYTES = 65536;
const MAX_LEN = 30;

// 正文外面裹着 <timestamp> / <user_query> 之类的壳，名字只要用户真正打的那句
const QUERY_TAG = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

function cachePath(sessionKey) {
    return sharedTmpPath(`cursor-name-${sessionKey}.json`);
}

/** 只读文件头 */
function readHead(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
        return buf.subarray(0, read).toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关掉 */ } }
    }
}

/** 文件头里第一条用户消息的原始文本。第一行一般就是它，但别写死 */
function firstUserText(head) {
    for (const line of String(head).split('\n')) {
        if (!line.trim()) continue;
        let entry;
        // 头部是截断的，最后一行大概率解析失败——跳过而不是放弃整次解析
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || entry.role !== 'user') continue;
        const content = entry.message && entry.message.content;
        const text = Array.isArray(content)
            ? (content.find((c) => c && c.type === 'text') || {}).text
            : content;
        if (typeof text === 'string' && text.trim()) return text;
    }
    return '';
}

/** 原始文本 → 一行短名字 */
function tidy(text) {
    const matched = QUERY_TAG.exec(String(text || ''));
    const inner = matched ? matched[1] : String(text || '');
    const line = inner
        .replace(/<[^>]+>/g, ' ')   // 其余壳标签（system_reminder / attached_files…）
        .split('\n')
        .map((s) => s.trim())
        .find(Boolean) || '';
    const squeezed = line.replace(/\s+/g, ' ').trim();
    return squeezed.length > MAX_LEN ? squeezed.slice(0, MAX_LEN) + '…' : squeezed;
}

/**
 * 会话名，算过一次就落盘缓存。
 *
 * 缓存不只是为了省一次读：`stop` 这类事件万一不带 `transcript_path`，也得靠它兜底，
 * 而完成卡恰恰是最需要标名字的那张。第一条用户消息永远不变，所以缓存不设过期。
 */
function conversationName(event) {
    const key = event && event.sessionKey;
    if (!key) return '';

    const cache = cachePath(key);
    try {
        const { name } = JSON.parse(fs.readFileSync(cache, 'utf8'));
        if (name) return name;
    } catch { /* 没缓存 = 这个会话还没算过 */ }

    const file = event.meta && event.meta.transcriptPath;
    if (!file) return '';

    const name = tidy(firstUserText(readHead(file)));
    if (!name) return '';
    try {
        fs.writeFileSync(cache, JSON.stringify({ name, ts: Date.now() }), 'utf8');
    } catch { /* 缓存写不进去只是每次多读一遍，不影响正确性 */ }
    return name;
}

module.exports = {
    conversationName,
    cachePath,
    firstUserText,
    tidy,
    MAX_LEN,
};
