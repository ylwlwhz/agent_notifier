'use strict';

const HOST_META = Object.freeze({
    claude: {
        label: 'Claude',
        template: 'blue',
    },
    codex: {
        label: 'Codex',
        template: 'turquoise',
    },
    cursor: {
        label: 'Cursor',
        template: 'indigo',
    },
});

function getHostHeaderMeta(host) {
    return HOST_META[host] || {
        label: host || 'Unknown',
        template: 'grey',
    };
}

function renderSessionHeader(session = {}) {
    const meta = getHostHeaderMeta(session.host);
    const terminal = session.pts_device || session.terminal?.ptsDevice || session.terminal?.tmuxTarget || 'unknown';
    const sessionId = session.id || session.sessionId || 'unknown';
    const sessionIdText = typeof sessionId === 'string' ? sessionId : String(sessionId);
    const status = session.status || 'unknown';

    return `${meta.label} | ${status} | ${sessionIdText.slice(0, 12)} | ${terminal}`;
}

function buildHostAwareHeader(session = {}, title) {
    const meta = getHostHeaderMeta(session.host);

    return {
        title: {
            tag: 'plain_text',
            content: title || renderSessionHeader(session),
        },
        template: meta.template,
    };
}

module.exports = {
    buildHostAwareHeader,
    getHostHeaderMeta,
    renderSessionHeader,
};
