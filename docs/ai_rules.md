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

整套流程支持 macOS 与 Linux，可在 Linux 服务器上 `git clone` + `install.sh` 独立部署。
以下规则均经 Linux（Ubuntu 22.04 + zsh）真机验证，**改动前务必读完，多条是反直觉的踩坑结论**。

### 11.1 shell 包装函数注入（claude()/codex()）

- **zsh：注入 `~/.zshenv`**（不是 `~/.zshrc`）。`.zshenv` 对所有 zsh 加载（含非交互 login）。
- **bash：直接注入 login 文件**（`~/.bash_profile`，无则 `~/.profile`）**＋ `~/.bashrc` 各一份**。
  - ⚠️ **不能靠"注入 .bashrc + 让 login 文件 source .bashrc"**：很多发行版（Ubuntu）默认 `.bashrc`
    顶部有 `case $- in *i*) ;; *) return;; esac`，非交互即 return，函数永远加载不到。
    login 文件对 `bash -l -c` 无条件执行，函数必须直接进 login 文件。
- 为什么必须覆盖非交互 login：`claude-remote-shell` 用 `"$SHELL" -l -c "exec claude ..."`
  （非交互 login）启动，函数缺失会导致 PTY 中继拉不起。
- wrapper 内解析"真二进制路径"（跳过同名函数）：用 **`$(unset -f NAME 2>/dev/null; command -v NAME)`**。
  - ⚠️ **不要用 `type -P`**：它是 bash 专有，zsh 的 `type` 不认 `-P`，会报 `bad option: -P`
    并返回空 → pty-relay 收到空命令 `execv() arg 2 first element cannot be empty`。
  - ⚠️ 也不能在 wrapper 内直接 `command -v claude`：此时 claude 已是函数名，会拿到函数自身。

### 11.2 平台相关写法必须双分支，不写死单平台

- 日期：GNU `date -u -d "...Z" +%s` vs BSD `date -j -u -f`（见 `scripts/statusline.sh`，用 `date --version` 探测）
- 逆序：`tac`（GNU）vs `tail -r`（BSD）
- 终端解析：Linux `/proc/<pid>/fd/0` vs macOS `ps -o tt=`（见 `src/lib/terminal-inject.js`）
- `sed -i`：GNU 用 `sed -i`，BSD/macOS 用 `sed -i ''`。统一封装 `sed_inplace`（见 `uninstall.sh`）
- 运行器/可执行路径一律 PATH 查找（`command -v` / `bunx||npx||bun x`），不写死 `/opt/homebrew/...`
- 下载用 curl 必须带超时（`--connect-timeout`/`--max-time`）+ 重试；GitHub raw 偶发瞬时卡死会拖死整个脚本

### 11.3 终端注入：tmux 路径 vs FIFO 路径（关键）

注入有两条**互斥**路径，按是否在 tmux 中自动选择（`claude()` 函数里 `-z "$TMUX"` 判定）：

- **非 tmux**：启动 pty-relay，建 PTY + FIFO，注入走 FIFO（base64 透传**原始字节**，Claude TUI 自行解析 ESC 序列）。
- **tmux 中**：**不启动 pty-relay**（这是正确设计，非 bug），注入走 `tmux send-keys`。
  - ⚠️ tmux send-keys **不透传原始 ESC 序列**，方向键 `\x1b[A/B/C/D` 必须翻译成具名键
    `Up/Down/Right/Left`，否则会被逐字节拆成 `Escape` + `[` + `B`（3 个独立键），选项卡导航错乱。
    见 `injectViaTmux`（`src/lib/terminal-inject.js`）。
  - **推论：改选项卡注入逻辑后，tmux 和 FIFO 两条路径都要验**。历史上选项卡只在 FIFO 下测过，
    一上 tmux 就暴露方向键 bug。FIFO 下对的写法（原始字节）在 tmux 下不一定对。

### 11.4 多端共用一个飞书 App 会互相串扰

- 飞书回调是**广播**：同一个 App 下，所有在线 listener（macOS、104……）都会收到**每一次**卡片点击。
- 每台机器的 listener 只在**自己的 `session-state.json`** 里查 notification；找不到就报"通知已过期或已处理"。
- 所以"A 机发的卡，B 机 listener 也收到回调但报已过期"是**正常现象，不是 bug**。
- 调试回注时务必先确认：**发卡的 claude 和处理回调的 listener 是同一台机器**。
- 多端同时使用需隔离（不同 `FEISHU_CHAT_ID` 或不同 App），否则卡片归属会混。

### 11.5 组件关系

- `scripts/statusline.sh` 跨平台 statusLine，install.sh 拷到 `~/.claude/statusline.sh` 并接入 `cost-capture.js`
- claude-remote-shell 只把 **Bash 工具命令** ssh 到远程执行；TUI / hooks / statusLine / 发卡 / 回注全在本机，
  与 agent-notifier 不冲突（详见 README「跨平台部署」）

### 11.6 验证纪律（迁移类改动）

- 静态/模拟验证**远不够**——本次 5 个真机 bug（SHELL_RC unbound、bash early-return、type -P、
  tmux 方向键、crs 无超时）静态全漏了，只有真机暴露。改 install/shell/注入后必须上目标平台真跑。
- 改 install.sh 后在干净环境验**幂等**（重跑先 uninstall 再装，不残留、不重复注入）。
- 注入类改动要做**字节级验证**（pane 内 `timeout 3 cat | od -c` 看实收字节），不要只看"没报错"。

