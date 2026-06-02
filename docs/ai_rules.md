# AI 开发规则

## 1. 文档与语言

- 本项目 AI 相关文档、对话、代码注释、CLI 输出、提交信息统一使用中文。
- 代码标识符、目录名、脚本名保持英文。
- 面向 AI 的说明优先写在 `docs/ai_rules.md` 与 `docs/ai_docs/`，避免把关键背景只放在聊天记录里。

## 2. 当前支持范围

本仓库当前支持两个交互宿主：

- `Claude`：基于 hooks 的本地集成
- `Codex CLI`：基于本地终端会话与 session 文件的集成

当前明确不支持：

- `codex_app` 云端任务模式

## 3. 代码结构约束

- 新的运行时代码统一放在 `src/` 下。
- 仓库根目录脚本只保留轻量入口，不要继续堆业务逻辑：
  - `hook-handler.js`
  - `ask-handler.js`
  - `live-handler.js`
  - `feishu-listener.js`
- 宿主专属逻辑分层放置：
  - Claude 相关适配放在 `src/adapters/claude`
  - Codex 相关适配放在 `src/adapters/codex`
- 飞书通道层统一放在 `src/channels/feishu`
- Codex 运行态应用统一放在 `src/apps`
- 所有飞书卡片都必须带宿主身份，至少能区分 `Claude` 与 `Codex`
- 旧卡片不能因为新卡片出现而被无条件废弃；交互卡要靠超时、提交、取消来收敛

## 4. Codex / Claude 链路约束

### Claude

- Claude 的实时摘要基于 hook 事件与 transcript
- `FEISHU_LIVE_CAPTURE` 语义来源于 Claude 的实现，是全项目的基准语义

### Codex

- Codex 的交互卡由 `src/apps/codex-watcher.js` 处理
- Codex 的实时摘要由 `src/apps/codex-live.js` 处理
- Codex 的真实 assistant 输出来自 `~/.codex/sessions/*.jsonl`
- `src/apps/codex-session-watcher.js` 负责把 session 中的 assistant message 与 token 信息写入 live buffer
- `pty-relay.py` 只负责 PTY/输入桥接与 live capture 启动，不应继续承担“猜测 assistant 正文”的主职责

## 5. 飞书实时摘要语义

- `FEISHU_LIVE_CAPTURE=1` 或 `true`
  - 开启全部实时摘要采集
- `FEISHU_LIVE_CAPTURE=tools,output,results`
  - `tools`：工具/命令摘要
  - `output`：助手输出文字
  - `results`：工具结果摘要

Codex 的实时摘要规则：

- 同一任务：`patch` 同一张卡
- 新任务：`create` 新卡
- 任务边界由 `assistant_key` 决定，不靠 PTY 文本前缀猜测

## 6. 卡片展示约束

### Codex 实时摘要卡

- 纯助手输出卡不显示伪造的“步骤表”
- `final_answer` 使用绿色完成卡
- 长文本必须分块，避免飞书截断
- footer 统一包含：
  - `🤖 Codex`
  - `🖥 pts/x`
  - `📁 项目名`
  - `⏱ 当前任务总时长`
  - `⏰ 时间`
  - `📊 输入 / 输出 / 缓存读 / 缓存写(仅在有数据时显示) / 总计`

### Codex 交互卡

- 文本输入、审批、单选、多选都要能通过飞书回流到终端
- 回流逻辑由 `src/channels/feishu/feishu-interaction-handler.js` 和 `src/adapters/codex/cli-input-bridge.js` 统一处理

## 7. 测试与验证

运行全量测试（推荐 bun，Node 16 不支持 `--test`）：

```bash
bun test tests/
```

### 测试目录结构

```
tests/
├── adapters/
│   ├── claude/
│   │   ├── fixture-ask.test.js        # Claude ask-handler 适配器固件
│   │   ├── fixture-hook.test.js       # Claude hook-handler 适配器固件
│   │   └── fixture-live.test.js       # Claude live-handler 适配器固件
│   └── codex/
│       ├── cli-input-bridge.test.js   # Codex 输入桥接：文本/审批/单选/多选注入
│       └── cli-output-parser.test.js  # Codex 终端输出解析
├── apps/
│   ├── claude-ask.test.js             # Claude AskUserQuestion 按钮映射 (↓+CR)
│   ├── codex-live.test.js             # Codex 实时摘要卡片
│   ├── codex-session-watcher.test.js  # Codex session 文件监控
│   ├── codex-watcher.test.js          # Codex PTY 输出监控与交互卡
│   └── feishu-listener.test.js               # 飞书监听器与交互回流
├── channels/
│   ├── codex-feishu-interaction-scenarios.test.js  # Codex 飞书交互端到端场景
│   └── feishu-interaction-handler.test.js          # 飞书交互处理器单元测试
├── core/
│   ├── card-state-store.test.js       # 卡片状态存储
│   └── session-store.test.js          # 会话存储
└── lib/
    └── session-state.test.js          # session-state 模块测试
```

### 专项测试

- Codex 解析/桥接：`bun test tests/adapters/codex/`
- Codex 应用层：`bun test tests/apps/codex-*.test.js`
- Claude 按钮映射：`bun test tests/apps/claude-ask.test.js`
- 飞书交互链路：`bun test tests/channels/`
- Python 语法检查：`python3 -m py_compile pty-relay.py`

### 原则

- 改解析器时，先补测试再改实现
- 改交互桥时，要覆盖文本、审批、单选、多选
- 改飞书卡片时，除了单测，还应做真机弹窗验证
- 终端注入使用 `\r`(CR) 作为 Enter，不用 `\n`(LF) — PTY raw mode 下 LF 不是 Enter

## 8. 运行与联调

Codex + 飞书联调至少需要这些进程在线：

- `node feishu-listener.js`
- `python3 pty-relay.py codex ...`
- `node src/apps/codex-session-watcher.js --pts <N>` 或由 `pty-relay.py` 自动拉起
- `node src/apps/codex-watcher.js`（交互卡与提示解析）

如果启动脚本提示 PID 存在但进程很快退出，优先直接前台启动排错：

- `node feishu-listener.js`
- `node src/apps/codex-watcher.js`
- `node src/apps/codex-session-watcher.js --pts <N>`

## 9. 真机验证脚本

- `scripts/send-codex-feishu-test-cards.js`
  - 发送 Codex 文本输入、审批、单选、多选交互卡
- `scripts/send-codex-assistant-direct.js`
  - 直接发送一张 Codex 文本卡，适合对账
- `scripts/send-codex-assistant-feed.js`
  - 通过 feed 方式发送 Codex assistant 摘要
- `npm run ask:e2e:card`
  - 发送 Claude 风格方案选择卡，适合验证 Claude 按钮注入

注意：

- `send-codex-feishu-test-cards.js` 只负责交互卡，不生成 `execution_summary`
- 要验证 Codex 实时摘要，应触发真实 session 输出，或向 `/tmp/codex-live-<pts>.jsonl` 写入受控测试数据

## 10. 提交原则

- 只提交与当前目标直接相关的文件
- 不要把运行产物、pid、缓存目录、临时日志带进提交
- 文档更新优先同步到：
  - `README.md`
  - `docs/ai_rules.md`
  - `docs/ai_docs/`

## 11. 跨平台与迁移

- 整套流程支持 macOS 与 Linux，可在 Linux 服务器上 `git clone` + `install.sh` 独立部署
- shell 包装函数注入位置：zsh 用 `~/.zshenv`（非 `~/.zshrc`），bash 用 `~/.bashrc` 并确保 login shell 加载
  - 原因：`claude-remote-shell` 用 `zsh -l -c` / `bash -l -c`（非交互 login）启动，`.zshrc`/非 source 的 `.bashrc` 不加载，会导致 PTY 中继拉不起
- 平台相关写法必须双分支，不写死单平台：
  - 日期：GNU `date -d` vs BSD `date -j -u -f`（见 `scripts/statusline.sh`）
  - 逆序：`tac` vs `tail -r`
  - 终端解析：Linux `/proc` vs macOS `ps -o tt=`（见 `src/lib/terminal-inject.js`）
  - 运行器路径用 PATH 查找（`type -P` / `command -v`），不写死 `/opt/homebrew/...`
- `scripts/statusline.sh` 是跨平台 statusLine 脚本，install.sh 拷到 `~/.claude/statusline.sh` 并接入 `cost-capture.js`
- claude-remote-shell 只重定向 Bash 工具命令到远程；TUI/hooks/statusLine 全在本机，与 agent-notifier 不冲突

