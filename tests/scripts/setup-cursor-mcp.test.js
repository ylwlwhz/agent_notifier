'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** mcpPath 在 require 时就定下来（读 CURSOR_MCP），所以必须先设环境变量再 require */
function loadSetup(mcpFile) {
    process.env.CURSOR_MCP = mcpFile;
    const modPath = require.resolve('../../scripts/setup-cursor-mcp');
    delete require.cache[modPath];
    return require(modPath);
}

function tmpMcpPath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'an-mcp-')), 'mcp.json');
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('从零安装：写出 mcpServers.agent-notifier-ask，指向 cursor-ask-mcp.js', () => {
    const file = tmpMcpPath();
    loadSetup(file).install();

    const cfg = read(file);
    const server = cfg.mcpServers['agent-notifier-ask'];
    assert.ok(server, 'MCP 服务必须写进去，否则 agent 看不到 ask_user');
    assert.equal(server.command, process.execPath, '用绝对 node 路径：Cursor 拉起时的 PATH 不一定含 node');
    assert.match(server.args[0], /src\/apps\/cursor-ask-mcp\.js$/);
});

test('幂等：反复装不会改动文件内容', () => {
    const file = tmpMcpPath();
    const setup = loadSetup(file);
    setup.install();
    const first = fs.readFileSync(file, 'utf8');
    setup.install();
    setup.install();
    assert.equal(fs.readFileSync(file, 'utf8'), first);
});

test('安装目录变了要能就地纠正，而不是留一份指向旧路径的配置', () => {
    const file = tmpMcpPath();
    fs.writeFileSync(file, JSON.stringify({
        mcpServers: { 'agent-notifier-ask': { command: 'node', args: ['/old/path/cursor-ask-mcp.js'] } },
    }));
    loadSetup(file).install();
    assert.doesNotMatch(read(file).mcpServers['agent-notifier-ask'].args[0], /^\/old\/path/);
});

test('不碰别人的 MCP 服务；卸载只删本仓库那一项', () => {
    const file = tmpMcpPath();
    fs.writeFileSync(file, JSON.stringify({
        mcpServers: { other: { command: 'uvx', args: ['some-server'] } },
    }));

    const setup = loadSetup(file);
    setup.install();
    assert.deepEqual(Object.keys(read(file).mcpServers).sort(), ['agent-notifier-ask', 'other']);

    setup.remove();
    assert.deepEqual(read(file).mcpServers, { other: { command: 'uvx', args: ['some-server'] } });
});

test('卸载后若一个服务都不剩，不留空壳键', () => {
    const file = tmpMcpPath();
    const setup = loadSetup(file);
    setup.install();
    setup.remove();
    assert.equal(read(file).mcpServers, undefined);
});

test('文件不存在时卸载不报错', () => {
    const file = tmpMcpPath();
    assert.doesNotThrow(() => loadSetup(file).remove());
});
