'use strict';

const fs = require('fs');

/** 反扫 transcript 全文：每行（JSON 解析失败跳过）调 callback，返 true 终止。
 *  单次读全文——累加型扫描必须无重叠，故不做分窗 */
function forEachTail(transcriptPath, callback) {
    if (!transcriptPath) return;
    let raw;
    try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return; }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        try { if (callback(JSON.parse(lines[i])) === true) return; } catch {}
    }
}

/** 反扫找首个 predicate 返非 undefined 的结果。先扫末尾 windowSize 字节（命中即止，
 *  绝大多数情况够），未命中再扫全文——predicate 无副作用，重扫幂等 */
function findTail(transcriptPath, predicate, windowSize = 32768) {
    if (!transcriptPath) return undefined;
    let fd;
    const scan = (len, offset) => {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const r = predicate(JSON.parse(lines[i]));
                if (r !== undefined) return r;
            } catch {}
        }
        return undefined;
    };
    try {
        fd = fs.openSync(transcriptPath, 'r');
        const { size } = fs.fstatSync(fd);
        let result = size > windowSize ? scan(windowSize, size - windowSize) : undefined;
        if (result === undefined) result = scan(size, 0);
        return result;
    } catch { return undefined; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** 单条 assistant message 内所有 text block 拼接（跳过 tool_use / thinking） */
function getAssistantText(d) {
    return (d?.message?.content || [])
        .filter(b => b.type === 'text' && b.text?.trim())
        .map(b => b.text).join('\n').trim();
}

/** 最近一条带 text 的 assistant message */
function extractLastAssistantText(transcriptPath) {
    return findTail(transcriptPath, (d) =>
        d.type === 'assistant' ? (getAssistantText(d) || undefined) : undefined
    ) || '';
}

module.exports = { forEachTail, findTail, getAssistantText, extractLastAssistantText };
