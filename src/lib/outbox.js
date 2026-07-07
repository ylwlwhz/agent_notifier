'use strict';

/**
 * Container → host outbox.
 *
 * In the "host owns all Feishu I/O" design, the in-container hooks no longer talk
 * to Feishu themselves. They resolve their local context (pts device, container
 * id, transcript-derived text) and drop a request file here; the single host-side
 * feishu-host service drains the directory and does all the Feishu work (build
 * card, send, store notification), then delegates keystroke injection back into
 * the container via `docker exec`.
 *
 * The directory is a bind mount shared host↔container:
 *   host       <repo>/.runtime/notifier/outbox
 *   container  /opt/agent-notifier/outbox
 *
 * Transport rules:
 *  - One JSON file per request. Writers write `<id>.json.tmp` then rename to
 *    `<id>.json` so a reader never sees a half-written file (rename is atomic
 *    within a directory).
 *  - Ids are lexicographically time-ordered (`<ts>-<rand>`) so drain() processes
 *    them roughly in submission order.
 *  - The watcher POLLS rather than using fs.watch: inotify/FSEvents do not
 *    propagate reliably across Docker's bind-mount virtualization, so a container
 *    write frequently fails to wake a host-side fs.watch. Polling is boring and
 *    correct; sub-second latency is fine here.
 */

const fs = require('fs');
const path = require('path');

let counter = 0;

/** Generate a lexicographically time-ordered request id. */
function newId() {
    counter = (counter + 1) % 100000;
    const rand = Math.random().toString(36).slice(2, 8);
    // zero-pad ts so string sort == chronological for the lifetime of the tool
    const ts = String(Date.now()).padStart(15, '0');
    return `${ts}-${String(counter).padStart(5, '0')}-${rand}`;
}

/**
 * Atomically enqueue a request object. Returns the request id.
 * Safe to call from short-lived hook processes.
 */
function enqueue(outboxDir, request) {
    fs.mkdirSync(outboxDir, { recursive: true });
    const id = (request && request.id) || newId();
    const finalPath = path.join(outboxDir, `${id}.json`);
    const tmpPath = path.join(outboxDir, `${id}.json.tmp`);
    const payload = JSON.stringify({ ...request, id }, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, finalPath);
    return id;
}

/**
 * Process every complete request file once, oldest first.
 *
 * For each request, `handler(request, id)` is awaited. If it resolves, the file
 * is deleted. If it throws, the file is renamed to `<id>.json.err` (kept for
 * inspection, not retried in a hot loop) and draining continues.
 * Malformed JSON is quarantined the same way.
 *
 * @returns {Promise<{processed:number, failed:number}>}
 */
async function drain(outboxDir, handler) {
    let names;
    try {
        names = fs.readdirSync(outboxDir);
    } catch {
        return { processed: 0, failed: 0 };
    }
    const files = names.filter((n) => n.endsWith('.json')).sort();
    let processed = 0;
    let failed = 0;
    for (const name of files) {
        const full = path.join(outboxDir, name);
        const id = name.replace(/\.json$/, '');
        let request;
        try {
            request = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (err) {
            quarantine(full);
            failed++;
            continue;
        }
        try {
            await handler(request, id);
            try { fs.unlinkSync(full); } catch {}
            processed++;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[outbox] handler failed for ${name}:`, err && err.message);
            quarantine(full);
            failed++;
        }
    }
    return { processed, failed };
}

function quarantine(full) {
    try { fs.renameSync(full, full.replace(/\.json$/, '.json.err')); } catch {
        try { fs.unlinkSync(full); } catch {}
    }
}

/**
 * Poll the outbox and drain it on an interval. Returns a stop() function.
 * Drains are never overlapped (a slow handler won't stack up timers).
 */
function watch(outboxDir, handler, { intervalMs = 400 } = {}) {
    fs.mkdirSync(outboxDir, { recursive: true });
    let stopped = false;
    let running = false;
    const tick = async () => {
        if (stopped || running) return;
        running = true;
        try { await drain(outboxDir, handler); } finally { running = false; }
    };
    const timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
    // kick once immediately so a request already sitting there is picked up fast
    tick();
    return function stop() {
        stopped = true;
        clearInterval(timer);
    };
}

module.exports = { enqueue, drain, watch, newId };
