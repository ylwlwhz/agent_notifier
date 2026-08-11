const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { injectKeys, injectText } = require('../../src/lib/terminal-inject');

// macOS 的 tty 是 /dev/ttysNNN，Linux 是 /dev/pts/N。injectKeys 的字符串
// dispatch 曾只认后者，于是 macOS 上每次注入都在 dispatch 处就 throw
// 'Unknown target format' —— 飞书卡片照常弹「已收到」（ack 是 fire-and-forget，
// 先于注入返回），但按键永远到不了终端。回归测试锁住两种命名都被接受。

/** 建一个「会重开」的 FIFO 读端，模拟 pty-relay.py 的监听循环，收集解码后的写入。 */
function collectFifo(fifoPath, ms = 2500) {
    const received = [];
    let stop = false;
    const loop = (async () => {
        while (!stop) {
            let fh;
            try {
                fh = await fs.promises.open(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
            } catch {
                return;
            }
            const deadline = Date.now() + 300;
            let buf = '';
            while (Date.now() < deadline && !stop) {
                try {
                    const { bytesRead, buffer } = await fh.read(Buffer.alloc(4096), 0, 4096, null);
                    if (bytesRead > 0) buf += buffer.slice(0, bytesRead).toString('utf8');
                } catch { /* EAGAIN：非阻塞读暂无数据 */ }
                await new Promise((r) => setTimeout(r, 10));
            }
            await fh.close();
            for (const line of buf.split('\n')) {
                if (line.trim()) received.push(Buffer.from(line, 'base64').toString('utf8'));
            }
        }
    })();
    return {
        received,
        async done() {
            await new Promise((r) => setTimeout(r, ms));
            stop = true;
            await loop;
            return received;
        },
    };
}

test('injectKeys 接受 macOS 的 /dev/ttysNNN，并经 FIFO 中继送达', async () => {
    // pts 分支把 FIFO 固定拼成 /tmp/agent-inject-pts<basename>（与 pty-relay.py 同源），
    // 所以这里必须用真实 /tmp 路径，才能覆盖「/dev/ttys → FIFO」这一步解析。
    // 设备号取一个不会与真实 tty 冲突的值。
    const dev = '/dev/ttys99999';
    const fifoPath = '/tmp/agent-inject-ptsttys99999';
    fs.rmSync(fifoPath, { force: true });
    execFileSync('mkfifo', [fifoPath]);

    try {
        const sink = collectFifo(fifoPath);
        await new Promise((r) => setTimeout(r, 100));
        await injectKeys(dev, 'hello\r');
        const got = await sink.done();

        assert.ok(got.length >= 1, `FIFO 应收到写入，实际: ${JSON.stringify(got)}`);
        assert.equal(got.join(''), 'hello\r', '文本与末尾 CR 都应送达（CR 单独一次写入）');
    } finally {
        fs.rmSync(fifoPath, { force: true });
    }
});

test('injectKeys 的 dispatch 同时认 Linux 与 macOS 的 tty 命名', async () => {
    // 用不存在的设备号：期望走完 pts 分支的各级 fallback 后失败，
    // 而不是在 dispatch 处以 'Unknown target format' 拒绝。
    for (const dev of ['/dev/ttys999', '/dev/pts/999']) {
        await assert.rejects(
            () => injectKeys(dev, 'x'),
            (err) => {
                assert.doesNotMatch(
                    err.message,
                    /Unknown target format/,
                    `${dev} 不应在 dispatch 处被拒绝（macOS 注入失效的根因）`
                );
                return true;
            }
        );
    }
});

test('真正非法的目标仍然被拒绝', async () => {
    await assert.rejects(
        () => injectKeys('not-a-target', 'x'),
        /Unknown target format/
    );
});

test('injectText 同样接受 macOS 命名（走同一 dispatch）', async () => {
    await assert.rejects(
        () => injectText('/dev/ttys999', 'hi'),
        (err) => {
            assert.doesNotMatch(err.message, /Unknown target format/);
            return true;
        }
    );
});
