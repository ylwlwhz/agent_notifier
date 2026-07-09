'use strict';

/**
 * In-container keystroke injection helper.
 *
 * Invoked by the host-side feishu-host service via:
 *   docker exec <container> node /opt/agent-notifier/src/apps/inject-keys.js <target> <base64-keys>
 *
 * It runs INSIDE the sandbox container — where the injection FIFO / pty master /
 * tmux pane actually live — and hands the decoded keys to the normal
 * terminal-inject path (FIFO relay → pty master → TIOCSTI). This is the local
 * end of the host→container injection primitive (see terminal-inject.js
 * injectViaContainer): the host owns Feishu + state, but only the container can
 * reach its own terminal.
 *
 *   target      fifo:/tmp/agent-inject-ptsN | /dev/pts/N | tmux:sess:win.pane
 *   base64-keys the key string, base64-encoded so control bytes (ESC sequences,
 *               CR) survive the argv/`docker exec` boundary intact.
 *
 * Exit code 0 on success, 1 on failure (stderr carries the reason).
 */

const { injectKeys } = require('../lib/terminal-inject');

async function main() {
    const target = process.argv[2];
    const b64 = process.argv[3];
    if (!target || b64 === undefined) {
        console.error('usage: inject-keys.js <target> <base64-keys>');
        process.exit(2);
    }
    let keys;
    try {
        keys = Buffer.from(b64, 'base64').toString('utf8');
    } catch (err) {
        console.error('[inject-keys] invalid base64:', err.message);
        process.exit(2);
    }
    await injectKeys(target, keys);
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[inject-keys]', err && err.message ? err.message : String(err));
            process.exit(1);
        });
}

module.exports = { main };
