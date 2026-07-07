'use strict';

/**
 * Relay mode helpers for the in-container hooks.
 *
 * When AGENT_NOTIFIER_RELAY=host, the single host-side feishu-host service owns
 * all Feishu I/O. Hooks stop talking to Feishu directly and instead drop a
 * self-contained request into the shared outbox (a bind-mounted dir); the host
 * drains it, builds/sends the card, stores the notification, and later injects
 * keystrokes back into this container via `docker exec`.
 *
 * When the env is absent (or set to anything else), hooks fall back to the
 * legacy in-container behaviour (send directly, listener injects locally).
 */

const os = require('os');
const { enqueue } = require('./outbox');

const DEFAULT_OUTBOX = '/opt/agent-notifier/outbox';

function outboxDir() {
    return process.env.AGENT_NOTIFIER_OUTBOX || DEFAULT_OUTBOX;
}

function isRelayMode() {
    return process.env.AGENT_NOTIFIER_RELAY === 'host';
}

/**
 * The docker id/name the host uses to `docker exec` back into THIS container.
 * Defaults to the container hostname, which Docker sets to the short container
 * id unless --hostname was given; claude-docker can override explicitly.
 */
function containerId() {
    return process.env.AGENT_NOTIFIER_CONTAINER_ID || os.hostname();
}

/** Enqueue a request for the host. Returns the request id. */
function enqueueRequest(req) {
    return enqueue(outboxDir(), req);
}

module.exports = { isRelayMode, enqueueRequest, outboxDir, containerId };
