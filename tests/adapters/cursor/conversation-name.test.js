'use strict';

/**
 * 对话名称：Cursor 的 payload 里没有名称字段（2026-09-04 真机探针确认），
 * 名字只能从 transcript 的第一条用户消息取。这里钉住取名规则与缓存行为。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const name = require('../../../src/adapters/cursor/conversation-name');

/** 造一份和真实 transcript 同形的 jsonl（第一行是被壳包住的用户消息） */
function writeTranscript(t, lines) {
    const file = path.join(os.tmpdir(), `an-transcript-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    t.after(() => { try { fs.unlinkSync(file); } catch { /* 已删 */ } });
    return file;
}

function userLine(text) {
    return JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
}

/** 每个用例都得清掉自己的缓存文件，否则会互相串味 */
function eventFor(t, sessionKey, transcriptPath) {
    t.after(() => { try { fs.unlinkSync(name.cachePath(sessionKey)); } catch { /* 没写成 */ } });
    return { sessionKey, meta: { transcriptPath } };
}

test('从第一条用户消息取名，剥掉 <timestamp> / <user_query> 这层壳', (t) => {
    const file = writeTranscript(t, [
        userLine('<timestamp>Wednesday, Aug 26, 2026, 4:50 PM (UTC+8)</timestamp>\n<user_query>\n让仓库也支持 cursor 的远程控制\n</user_query>'),
        userLine('<user_query>后面这条不该被当成名字</user_query>'),
    ]);

    assert.equal(name.conversationName(eventFor(t, 'conv-nm01', file)), '让仓库也支持 cursor 的远程控制');
});

test('超长就截断加省略号：副标题只有一行位置', (t) => {
    const long = '这是一个特别长的需求描述'.repeat(10);
    const file = writeTranscript(t, [userLine(`<user_query>${long}</user_query>`)]);

    const got = name.conversationName(eventFor(t, 'conv-nm02', file));
    assert.equal(got.length, name.MAX_LEN + 1, '截断后应是 MAX_LEN 个字符 + 一个省略号');
    assert.ok(got.endsWith('…'));
});

test('第一行不是用户消息时继续往下找，不返回空名字', () => {
    const head = [
        JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '我先看看仓库' }] } }),
        userLine('<user_query>真正的第一句话</user_query>'),
    ].join('\n');

    assert.equal(name.tidy(name.firstUserText(head)), '真正的第一句话');
});

test('文件头被截断导致末行 JSON 不完整时，前面的行照样能用', () => {
    const head = userLine('<user_query>完整的一行</user_query>') + '\n{"role":"user","messa';
    assert.equal(name.tidy(name.firstUserText(head)), '完整的一行');
});

test('多行输入只取第一行非空内容', () => {
    assert.equal(name.tidy('<user_query>\n\n第一行\n第二行\n</user_query>'), '第一行');
});

test('壳标签之外没有正文时给空名字，卡片就不渲染副标题', () => {
    assert.equal(name.tidy('<system_reminder>只有提醒</system_reminder>'), '只有提醒');
    assert.equal(name.tidy(''), '');
    assert.equal(name.firstUserText('不是 JSON 的一行'), '');
});

test('算过一次就落盘：transcript 没了也还能报出名字（stop 事件可能不带路径）', (t) => {
    const file = writeTranscript(t, [userLine('<user_query>缓存这个名字</user_query>')]);
    const event = eventFor(t, 'conv-nm03', file);

    assert.equal(name.conversationName(event), '缓存这个名字');
    assert.ok(fs.existsSync(name.cachePath('conv-nm03')));

    // 拿不到 transcript_path 的事件（实测 stop 的 payload 未必带）也要能报出名字
    assert.equal(name.conversationName({ sessionKey: 'conv-nm03', meta: {} }), '缓存这个名字');
});

test('既没缓存也没 transcript 就返回空串，绝不抛异常', (t) => {
    assert.equal(name.conversationName({ sessionKey: 'conv-nm04', meta: {} }), '');
    assert.equal(name.conversationName({}), '');
    assert.equal(name.conversationName(eventFor(t, 'conv-nm05', '/tmp/definitely-not-here-7c1e.jsonl')), '');
});
