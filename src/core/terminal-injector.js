'use strict';

function normalizeResponse(response) {
    if (response == null) return {};
    if (typeof response === 'string') {
        return { responseType: 'text', value: response };
    }
    if (typeof response !== 'object') return {};
    return response;
}

function createTerminalInjector({ injectText }) {
    if (typeof injectText !== 'function') {
        throw new TypeError('createTerminalInjector requires injectText');
    }

    return {
        async deliver(response, target) {
            const normalized = normalizeResponse(response);

            if (normalized.responseType === 'text') {
                // 3×Ctrl-U 清 input 残留，避免拼接上次未提交内容
                const CLEAR = '\x15'.repeat(3);
                return injectText(target, `${CLEAR}${normalized.value}\r`);
            }

            if (normalized.responseType === 'approve') {
                return injectText(target, 'y\r');
            }

            if (normalized.responseType === 'reject') {
                return injectText(target, 'n\r');
            }

            return null;
        },
    };
}

module.exports = { createTerminalInjector };
