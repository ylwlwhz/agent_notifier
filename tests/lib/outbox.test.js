const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enqueue, drain, watch, newId } = require('../../src/lib/outbox');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-test-'));
}

test('enqueue writes an atomic .json file (no leftover .tmp) and drain reads it', async () => {
    const dir = tmpDir();
    const id = enqueue(dir, { kind: 'ask', pts_device: 'fifo:/tmp/x', container_id: 'abc' });

    const files = fs.readdirSync(dir);
    assert.deepEqual(files, [`${id}.json`], 'only the final .json should remain');

    const seen = [];
    const res = await drain(dir, async (req) => { seen.push(req); });

    assert.equal(res.processed, 1);
    assert.equal(res.failed, 0);
    assert.equal(seen[0].kind, 'ask');
    assert.equal(seen[0].container_id, 'abc');
    assert.equal(seen[0].id, id, 'id is embedded into the request');
    assert.deepEqual(fs.readdirSync(dir), [], 'processed file is deleted');
});

test('drain processes requests oldest-first by id order', async () => {
    const dir = tmpDir();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(enqueue(dir, { kind: 'ask', n: i }));

    const order = [];
    await drain(dir, async (req) => { order.push(req.n); });
    assert.deepEqual(order, [0, 1, 2, 3, 4], 'FIFO order preserved');
});

test('a throwing handler quarantines the file as .json.err and keeps draining', async () => {
    const dir = tmpDir();
    enqueue(dir, { kind: 'bad', n: 0 });
    const good = enqueue(dir, { kind: 'good', n: 1 });

    const processed = [];
    const res = await drain(dir, async (req) => {
        if (req.kind === 'bad') throw new Error('boom');
        processed.push(req.n);
    });

    assert.equal(res.processed, 1);
    assert.equal(res.failed, 1);
    assert.deepEqual(processed, [1], 'good request still processed after bad one');
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, 1);
    assert.match(files[0], /\.json\.err$/, 'bad request quarantined, not deleted');
    assert.equal(fs.existsSync(path.join(dir, `${good}.json`)), false, 'good request deleted');
});

test('malformed JSON is quarantined, not crashing the drain', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, `${newId()}.json`), '{not valid json');
    const res = await drain(dir, async () => { throw new Error('should not be called'); });
    assert.equal(res.processed, 0);
    assert.equal(res.failed, 1);
    assert.match(fs.readdirSync(dir)[0], /\.json\.err$/);
});

test('a half-written .tmp file is ignored by drain (atomicity)', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'inflight.json.tmp'), '{"partial":');
    const res = await drain(dir, async () => {});
    assert.equal(res.processed, 0);
    assert.equal(res.failed, 0, '.tmp is not a .json and must be skipped');
    assert.ok(fs.existsSync(path.join(dir, 'inflight.json.tmp')), '.tmp left untouched');
});

test('watch polls and drains newly enqueued requests, stop() halts it', async () => {
    const dir = tmpDir();
    const got = [];
    const stop = watch(dir, async (req) => { got.push(req.n); }, { intervalMs: 20 });
    try {
        enqueue(dir, { n: 'a' });
        await new Promise((r) => setTimeout(r, 80));
        enqueue(dir, { n: 'b' });
        await new Promise((r) => setTimeout(r, 80));
        assert.deepEqual(got.sort(), ['a', 'b']);
    } finally {
        stop();
    }
    // after stop, new requests are not drained
    enqueue(dir, { n: 'c' });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(!got.includes('c'), 'stop() prevents further draining');
});
