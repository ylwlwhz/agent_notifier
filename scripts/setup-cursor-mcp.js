#!/usr/bin/env node
'use strict';

/**
 * 幂等地把 ask_user 这个 MCP 服务写进 ~/.cursor/mcp.json。
 *
 * 用法:
 *   node scripts/setup-cursor-mcp.js            安装 / 更新
 *   node scripts/setup-cursor-mcp.js --remove   卸载（只删本仓库注入的那一项）
 *
 * 环境变量:
 *   AGENT_NOTIFIER_DIR   安装目录（默认取本脚本上一级）
 *   CURSOR_MCP           mcp.json 路径（默认 ~/.cursor/mcp.json）
 *
 * 为什么要有这个服务：IDE 自带的交互式选择题不触发任何 hook，人在外面看不到也无法回答
 * （见 docs/ai_rules.md 的实测结论）。MCP 工具调用有正常返回值，可以由我们的进程阻塞着
 * 等飞书回答再把答案交回 agent —— 这是官方通道里唯一能承载「远程作答」的那一条。
 *
 * 装到用户级而不是项目级：这个能力与项目无关，且项目级 .cursor/mcp.json 会被提交进
 * 别人的仓库（与 setup-cursor-hooks.js 同一考虑）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const installDir = process.env.AGENT_NOTIFIER_DIR || path.join(__dirname, '..');
const mcpPath = process.env.CURSOR_MCP || path.join(os.homedir(), '.cursor', 'mcp.json');

// 服务名即识别特征：卸载与幂等判定都靠它
const SERVER_NAME = 'agent-notifier-ask';

function buildServerConfig() {
    return {
        command: process.execPath,
        args: [path.join(installDir, 'src', 'apps', 'cursor-ask-mcp.js')],
    };
}

function loadMcpFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeMcpFile(config) {
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
}

function install() {
    const config = loadMcpFile();
    if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};

    const desired = buildServerConfig();
    const current = config.mcpServers[SERVER_NAME];

    if (JSON.stringify(current) === JSON.stringify(desired)) {
        console.log(`[agent-notifier] MCP 服务 ${SERVER_NAME} 已是最新`);
        return;
    }

    // 就地更新而不是追加：node 路径或安装目录变了要能纠正
    config.mcpServers[SERVER_NAME] = desired;
    writeMcpFile(config);
    console.log(`  ${current ? '~ 更新' : '+ 添加'} MCP 服务: ${SERVER_NAME}`);
    console.log(`[agent-notifier] 已写入 ${mcpPath}`);
    console.log('  提示：Cursor 需要重新加载 MCP 配置（重开窗口，或在 Settings → MCP 里刷新）才会看到 ask_user');
}

function remove() {
    if (!fs.existsSync(mcpPath)) {
        console.log('[agent-notifier] 未找到 mcp.json，跳过');
        return;
    }
    const config = loadMcpFile();
    if (!config.mcpServers || !config.mcpServers[SERVER_NAME]) {
        console.log('[agent-notifier] MCP 服务未安装，无需移除');
        return;
    }

    delete config.mcpServers[SERVER_NAME];
    // 只剩空对象就把这个键一并删掉，别在用户配置里留空壳
    if (!Object.keys(config.mcpServers).length) delete config.mcpServers;
    writeMcpFile(config);
    console.log(`[agent-notifier] 已从 ${mcpPath} 移除 MCP 服务 ${SERVER_NAME}`);
}

if (require.main === module) {
    if (process.argv.includes('--remove')) remove();
    else install();
}

module.exports = { install, remove, buildServerConfig, mcpPath, SERVER_NAME };
