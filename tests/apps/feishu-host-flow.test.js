// End-to-end dry run of the "host owns all Feishu I/O" path, with fakes for the
// two external edges (Feishu API + `docker exec`). Proves the wiring:
//
//   hook request  →  outbox  →  host builds/sends card + stores notification
//                              →  card callback  →  handleCardAction
//                              →  injection routed to the RIGHT container
//
// No real Feishu, no real containers.

// Constructor requires creds or it process.exit(1)s — set before requiring.
process.env.FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'test-app-id';
process.env.FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || 'test-app-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enqueue, drain } = require('../../src/lib/outbox');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'host-flow-')); }

// Fake `docker` that records `docker exec <cid> node <helper> <target> <b64>`.
function installFakeDocker(dir) {
    const log = path.join(dir, 'docker-calls.log');
    const bin = path.join(dir, 'docker');
    fs.writeFileSync(bin, [
        '#!/usr/bin/env bash',
        // argv: exec($1) <cid>($2) node($3) <helper>($4) <target>($5) <b64>($6)
        'printf "%s\\t%s\\t%s\\n" "$2" "$5" "$6" >> "' + log + '"',
        'exit 0',
    ].join('\n'));
    fs.chmodSync(bin, 0o755);
    return { bin, log };
}

function fakeFeishu() {
    const sent = [];
    const client = {
        im: {
            message: {
                create: async ({ data }) => {
                    sent.push(JSON.parse(data.content));
                    return { data: { message_id: `msg_${sent.length}` } };
                },
                patch: async () => ({}),
            },
            chat: { list: async () => ({ data: { items: [{ chat_id: 'oc_test' }] } }) },
        },
    };
    return { sent, client };
}

test('multi-select ask: outbox → host send/store → callback → injection routed to container', async () => {
    const dir = tmp();
    const outbox = path.join(dir, 'outbox');
    const stateFile = path.join(dir, 'session-state.json');
    const { bin: dockerBin, log: dockerLog } = installFakeDocker(dir);

    process.env.AGENT_NOTIFIER_DOCKER = dockerBin;
    process.env.AGENT_NOTIFIER_STATE = stateFile;
    process.env.AGENT_NOTIFIER_INJECT_HELPER = '/opt/agent-notifier/src/apps/inject-keys.js';

    const { SessionState } = require('../../src/lib/session-state');
    const { FeishuListener } = require('../../src/apps/feishu-listener');
    const { handleAskRequest } = require('../../src/apps/claude-ask');

    const state = new SessionState(stateFile);
    const injectTargetFor = (n) =>
        (n && n.container_id && n.pts_device) ? `exec@${n.container_id}@${n.pts_device}` : (n && n.pts_device);

    const listener = new FeishuListener({ state, injectTargetFor });
    const { sent, client } = fakeFeishu();
    listener.client = client; // stub outbound Feishu (ack card, etc.)
    const app = { client, chatId: 'oc_test' };

    // 1) A hook enqueues a fully-resolved multi-select ask request.
    const req = {
        kind: 'ask',
        questions: [{
            question: 'Pick fruits',
            header: 'Fruits',
            multiSelect: true,
            options: [
                { label: 'Apple', description: 'a' },
                { label: 'Banana', description: 'b' },
                { label: 'Cherry', description: 'c' },
            ],
        }],
        session_id: 'sess1234abcd',
        context_text: '',
        project_name: 'demo',
        pts_device: 'fifo:/tmp/agent-inject-pts1',
        container_id: 'deadbeefcafe',
        state_key: 'feishu_ask_sess1234_1',
        notification_type: 'AskUserQuestion',
    };
    enqueue(outbox, req);

    // 2) Host drains the outbox → builds/sends card + stores notification.
    const drained = await drain(outbox, (r) => handleAskRequest(app, r, { state }));
    assert.equal(drained.processed, 1, 'request processed');
    assert.equal(sent.length, 1, 'exactly one card sent (the multi-select card)');

    const notif = state.getNotification('feishu_ask_sess1234_1');
    assert.ok(notif, 'notification stored under the state key');
    assert.equal(notif.container_id, 'deadbeefcafe', 'container id stored for routing');
    assert.deepEqual(notif._ms_options, ['Apple', 'Banana', 'Cherry']);
    assert.equal(notif.pts_device, 'fifo:/tmp/agent-inject-pts1', 'pts stays clean (unwrapped)');

    // 3) Simulate a Feishu card callback: submit options 1 and 3 (Apple, Cherry).
    const callback = {
        event_id: 'evt1',
        create_time: '1700000000000',
        action: {
            tag: 'input',
            input_value: '1 3',
            value: { action_type: 'submit_multi', session_state_key: 'feishu_ask_sess1234_1' },
        },
    };
    const toast = await listener.handleCardAction(callback);
    assert.equal(toast, '已收到', 'callback acknowledged immediately');
    await listener._lastInjection; // background injection exposed for tests

    // 4) Verify injection was delegated to the RIGHT container via docker exec,
    //    with the expected keystrokes preserved through base64.
    const calls = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => {
            const [cid, target, b64] = line.split('\t');
            return { cid, target, keys: Buffer.from(b64, 'base64').toString('utf8') };
        });
    assert.ok(calls.length > 0, 'at least one docker exec injection happened');
    assert.ok(calls.every((c) => c.cid === 'deadbeefcafe'), 'every injection targets the owning container');
    assert.ok(calls.every((c) => c.target === 'fifo:/tmp/agent-inject-pts1'), 'inner target is the clean pts');

    const combined = calls.map((c) => c.keys).join('');
    // Current TUI: Enter (\r) toggles each selected checkbox; Down (ESC[B)
    // navigates; a final Enter submits on the "Submit" row. Two options selected
    // → ≥3 Enters (2 toggles + submit). No Space toggles, no '1' confirm anymore.
    const enters = (combined.match(/\r/g) || []).length;
    assert.ok(enters >= 3, `expected ≥3 Enter (2 toggles + submit), got ${enters}`);
    assert.ok(combined.includes('\x1b[B'), 'Down-arrow navigation present');
    assert.ok(!combined.includes('\x20'), 'no Space toggles (current TUI toggles with Enter)');

    // Notification consumed after submit.
    assert.equal(state.getNotification('feishu_ask_sess1234_1'), null, 'notification removed after submit');

    listener.stop();
});

test('multi-select form submit (multi_select_static): form_value converts to submit_multi path', async () => {
    const dir = tmp();
    const stateFile = path.join(dir, 'session-state.json');
    const { bin: dockerBin, log: dockerLog } = installFakeDocker(dir);

    process.env.AGENT_NOTIFIER_DOCKER = dockerBin;
    process.env.AGENT_NOTIFIER_STATE = stateFile;

    const { SessionState } = require('../../src/lib/session-state');
    const { FeishuListener } = require('../../src/apps/feishu-listener');

    const state = new SessionState(stateFile);
    const injectTargetFor = (n) =>
        (n && n.container_id && n.pts_device) ? `exec@${n.container_id}@${n.pts_device}` : (n && n.pts_device);
    const listener = new FeishuListener({ state, injectTargetFor });
    listener.client = fakeFeishu().client;

    await state.addNotificationAsync('feishu_ask_form_1', {
        session_id: 'sform', notification_type: 'AskUserQuestion',
        pts_device: 'fifo:/tmp/agent-inject-pts7', container_id: 'cidform',
        created_at: Date.now(), responses: {},
        _multi_select: true, _selected: [],
        _ms_options: ['Apple', 'Banana', 'Cherry'], _ms_total: 3,
        _message_id: 'om_form_msg_1',
    });

    // Native dropdown form submit: options 0 & 2 picked (→ "1 3"), no Other text.
    // Real-world callback shape (2026-07): NO action.value at all — routing must
    // fall back to context.open_message_id → notification._message_id.
    const toast = await listener.handleCardAction({
        event_id: 'evtF', create_time: '1',
        context: { open_message_id: 'om_form_msg_1' },
        action: {
            tag: 'button', name: 'ms_submit',
            form_value: { ms_opts: ['0', '2'], ms_other: '' },
        },
    });
    assert.equal(toast, '已收到', 'form submit acknowledged like typed submit');
    await listener._lastInjection;

    const combined = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => Buffer.from(l.split('\t')[2], 'base64').toString('utf8')).join('');
    const enters = (combined.match(/\r/g) || []).length;
    assert.ok(enters >= 3, `expected ≥3 Enter (2 toggles + submit), got ${enters}`);
    assert.ok(combined.includes('\x1b[B'), 'Down-arrow navigation present');
    assert.equal(state.getNotification('feishu_ask_form_1'), null, 'notification consumed');

    // Empty form submit → warning toast, notification stays pending.
    await state.addNotificationAsync('feishu_ask_form_2', {
        session_id: 'sform2', notification_type: 'AskUserQuestion',
        pts_device: 'fifo:/tmp/agent-inject-pts7', container_id: 'cidform',
        created_at: Date.now(), responses: {},
        _multi_select: true, _selected: [], _ms_options: ['A'], _ms_total: 1,
        _message_id: 'om_form_msg_2',
    });
    const empty = await listener.handleCardAction({
        event_id: 'evtF2', create_time: '2',
        context: { open_message_id: 'om_form_msg_2' },
        action: {
            tag: 'button', name: 'ms_submit',
            form_value: { ms_opts: [], ms_other: '' },
        },
    });
    assert.equal(empty.toast.type, 'warning', 'empty selection warns instead of fake success');
    assert.ok(state.getNotification('feishu_ask_form_2'), 'notification still pending after empty submit');

    listener.stop();
});

test('button reply (permission/Stop send_card path): callback → injection routed to container', async () => {
    const dir = tmp();
    const stateFile = path.join(dir, 'session-state.json');
    const { bin: dockerBin, log: dockerLog } = installFakeDocker(dir);

    process.env.AGENT_NOTIFIER_DOCKER = dockerBin;
    process.env.AGENT_NOTIFIER_STATE = stateFile;

    const { SessionState } = require('../../src/lib/session-state');
    const { FeishuListener } = require('../../src/apps/feishu-listener');

    const state = new SessionState(stateFile);
    const injectTargetFor = (n) =>
        (n && n.container_id && n.pts_device) ? `exec@${n.container_id}@${n.pts_device}` : (n && n.pts_device);
    const listener = new FeishuListener({ state, injectTargetFor });
    listener.client = fakeFeishu().client;

    // What the host's send_card dispatcher stores: a pre-built card's notification,
    // tagged with the owning container + its response keymap (from claude-hook).
    await state.addNotificationAsync('feishu_perm_1', {
        session_id: 'sabc',
        notification_type: 'permission_prompt',
        pts_device: 'fifo:/tmp/agent-inject-pts3',
        container_id: 'cid123abc',
        created_at: Date.now(),
        responses: {
            opt_1: { keys: '1', label: '已允许' },
            esc: { keys: '\x1b', label: 'Esc' },
            interrupt: { keys: '\x1b', label: '⛔ Interrupt' },
        },
    });

    const callback = {
        event_id: 'e', create_time: '1',
        action: { tag: 'button', value: { action_type: 'opt_1', session_state_key: 'feishu_perm_1' } },
    };
    await listener.handleCardAction(callback);
    await (listener._lastInjection || Promise.resolve()).catch(() => {});

    const calls = fs.readFileSync(dockerLog, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { const [cid, target, b64] = l.split('\t'); return { cid, target, keys: Buffer.from(b64, 'base64').toString('utf8') }; });
    assert.equal(calls.length, 1, 'exactly one injection for the button');
    assert.equal(calls[0].cid, 'cid123abc', 'routed to the owning container');
    assert.equal(calls[0].target, 'fifo:/tmp/agent-inject-pts3', 'clean pts as inner target');
    assert.equal(calls[0].keys, '1', "injected the option's key");

    listener.stop();
});

test('expired notification: warning toast only, original card left intact (no patch)', async () => {
    const dir = tmp();
    const stateFile = path.join(dir, 'session-state.json');
    process.env.AGENT_NOTIFIER_STATE = stateFile;

    const { SessionState } = require('../../src/lib/session-state');
    const { FeishuListener } = require('../../src/apps/feishu-listener');

    const state = new SessionState(stateFile);
    const listener = new FeishuListener({ state });
    listener.client = fakeFeishu().client;

    // No notification stored for this key — simulates the >12h-expired card.
    const callback = {
        event_id: 'e', create_time: '1',
        action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: 'feishu_ask_dead_1' } },
    };
    const result = await listener.handleCardAction(callback);
    assert.equal(result.toast.type, 'warning', 'honest warning toast, not fake success');
    assert.ok(!result.card, 'no card patch — expired card kept intact (its content still has reference value)');
    assert.ok(result.toast.content.includes('已过期'), 'toast honestly says the card expired');

    // Menu variant gets the menu-specific wording.
    const menuResult = await listener.handleCardAction({
        event_id: 'e2', create_time: '2',
        action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: 'feishu_launch_dead' } },
    });
    assert.equal(menuResult.toast.type, 'warning', 'menu expiry is also a warning toast');
    assert.ok(!menuResult.card, 'menu variant also leaves the card intact');
    assert.ok(menuResult.toast.content.includes('claude'), 'menu variant tells user to resend claude');

    listener.stop();
});
