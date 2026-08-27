'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 跨进程共享的临时目录。
 *
 * 不能用 os.tmpdir()：macOS 上 TMPDIR 是【按会话】分配的（/var/folders/xx/…/T/），
 * Cursor 拉起的 hook 进程与 launchd 拉起的 feishu-listener 会拿到两个不同的目录，
 * 双方各写各的、永远等不到对方。/tmp 是两边都稳定共享的唯一路径，仓库里
 * claude-live / agent-inject-pts 等文件也一直落在这里。
 */
function sharedTmpDir() {
    try {
        fs.accessSync('/tmp', fs.constants.W_OK);
        return '/tmp';
    } catch {
        return os.tmpdir();
    }
}

function sharedTmpPath(...parts) {
    return path.join(sharedTmpDir(), ...parts);
}

module.exports = { sharedTmpDir, sharedTmpPath };
