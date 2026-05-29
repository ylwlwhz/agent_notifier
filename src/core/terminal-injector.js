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
                // C-u×3 清空单独发一次：与文字同批会被当粘贴吞掉、清不了。文字+Enter 交给 injectViaTmux（内部拆 Enter）
                await injectText(target, '\x15'.repeat(3));
                return injectText(target, `${normalized.value}\r`);
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
