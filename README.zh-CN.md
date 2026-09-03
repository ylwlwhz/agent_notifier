[English](./README.md) | [中文](./README.zh-CN.md)

# Agent Notifier — Claude / Codex CLI / Cursor 飞书通知助手

> 把 AI 编程助手的所有交互搬到飞书，手机上就能批准、选方案、输指令，多终端同步，不用盯着终端。

## 为什么选择这个方案

| 痛点 | 本项目的解法 |
|------|-----------|
| Claude / Codex / Cursor 等权限、要确认，你必须守在终端前 | 飞书卡片实时推送，手机 / 电脑 / 平板任意设备点一下就行 |
| 想在手机上也能操作，但没有官方 App | 飞书就是你的多端 App，iOS / Android / Mac / Windows / Web 全覆盖 |
| 自建推送要服务器、域名、备案？ | 飞书长连接模式，不需要公网 IP 和域名，本机直连 |
| 企业审批流程繁琐？ | 飞书企业自建应用秒审批，个人也能用，完全免费 |
| 多个终端同时跑任务，通知乱了？ | 多终端并行路由，每个终端的交互独立送达，互不干扰 |

---

## 效果预览

<table>
<tr>
<td align="center" width="33%">
<img src="./docs/images/permission-confirm.jpg" width="240" /><br/>
<b>权限确认</b><br/>
<sub>允许 / 拒绝 / 会话允许 / 全局允许 + 输入框<br/>脚注：项目名 · 终端标识(fifo) · 会话时长</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/permission-options.jpg" width="240" /><br/>
<b>权限选项</b><br/>
<sub>ExitPlanMode 等工具选项按钮 + 输入框<br/>脚注：项目名 · 终端标识(fifo) · 会话时长</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/ask-user-question.jpg" width="240" /><br/>
<b>方案选择</b><br/>
<sub>AskUserQuestion 动态选项 + Other + 自由输入<br/>脚注：项目名 · 终端标识(fifo) · 时间戳</sub>
</td>
</tr>
<tr>
<td align="center" width="33%">
<img src="./docs/images/live-execution.jpg" width="240" /><br/>
<b>实时执行摘要</b><br/>
<sub>工具调用表格 · 同任务原地 patch 更新<br/>脚注：项目名 · 时间戳</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/task-complete.jpg" width="240" /><br/>
<b>任务完成</b><br/>
<sub>改动总结 + 输入框续聊<br/>脚注：项目名 · 会话时长 · Token 用量统计</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/task-complete-stats.jpg" width="240" /><br/>
<b>完成通知（带统计）</b><br/>
<sub>测试结果表格 + 输入框续聊<br/>脚注：项目名 · 会话时长 · Token 用量统计</sub>
</td>
</tr>
</table>

---

## 支持的卡片类型

| 场景 | 卡片颜色 | 说明 |
|------|---------|------|
| 权限确认 | 🟠 橙色 | 允许 / 本次会话允许 / 拒绝 + 输入框 |
| AskUserQuestion 单选 | 🟠 橙色 | 动态选项按钮 + Other + 输入框 |
| AskUserQuestion 多题 | 🟠 橙色 | Q1 → Q2 → Q3 逐张发送 |
| 任务完成 | 🟢 绿色 | 摘要、时长、Token + 输入框 |
| 异常退出 | 🔴 红色 | 错误详情 + 输入框 |
| 实时执行摘要 | 🔵 蓝色 | 同一任务原地 patch 更新 |
| Cursor 审批 | 🟠 橙色 | 允许 / 拒绝 / 交回本地 + 拒绝理由输入框 |
| Cursor 完成 | 🟢 绿色 | 摘要 + 输入框（回话即让 Cursor 自动续跑） |
| Cursor 实时摘要 | 🟣 靛蓝 | 工具折叠面板，同一轮原地 patch |

---

## 功能一览

**通知能力** — 飞书交互式卡片 / 任务完成与失败通知 / 实时执行摘要 / 会话时长与 Token 统计 / 本地语音提醒

**交互能力** — 按钮点击回流 / 文本输入回流 / 多终端并行路由 / Claude、Codex、Cursor 共用一套飞书入口

---

## 三个宿主的机制差异

三个宿主的"远程控制"走的是**两条完全不同的路**，这决定了你会遇到什么问题：

| | Claude | Codex CLI | Cursor |
|---|---|---|---|
| 事件来源 | Claude hooks | PTY 输出 + session 文件 | Cursor hooks |
| 回流通道 | 往终端注入按键 | 往终端注入按键 | **hook 直接返回裁决** |
| 需要 shell 包装函数 | 是（`claude()`） | 是（`codex()`） | **否** |
| 需要 pty-relay | 是（非 tmux 时） | 是（非 tmux 时） | **否** |
| 适用范围 | 终端里的 Claude Code | 终端里的 Codex CLI | Cursor IDE 与 CLI |

**为什么 Cursor 不一样**：Cursor 的 hook 是**阻塞式**进程 —— Cursor 把事件 JSON 写进 hook
的 stdin，然后**等** hook 在 stdout 上回一段 JSON 来决定下一步怎么走。于是「远程批准一条命令」
变成了「让 hook 进程等你在飞书上点一下，再把 `permission` 回给 Cursor」，既不用猜终端在哪，
也不存在按键被吞、方向键错乱这类注入问题。

代价是必须保证**永不把 Cursor 永久挂住**：本项目所有等待都有超时，超时后自动回落到
Cursor 自己的确认弹窗。

### Cursor 有两条链路，按「谁拥有会话」分工

hooks 只是旁路观察者，够不到 IDE 里已存在的会话（往里注入用户消息的唯一入口是 `stop` 的
`followup_message`，只在一轮结束的瞬间存在）。所以要想像 Claude 那样**随时**回话，
必须让会话由本仓库自己拥有：

| | IDE 里手工开的会话 | 飞书发 `cursor` 起的会话 |
|---|---|---|
| 走哪条链路 | hooks（`cursor-hook.js`） | cursor-agent CLI（`cursor-cli.js`） |
| 通知卡 | ✅ 完成 / 失败 / 实时摘要 | ✅ 一轮一张，流式 patch |
| 远程审批 | ✅ 阻塞等你点 | 默认自动放行（无人值守） |
| **随时回话** | ❌ 只有一轮结束的瞬间 | ✅ **任何时候**，无超时 |
| 执行中发指令 | ❌ | ✅ 自动排队，本轮结束后接着跑 |

两条链路互不干扰，装好后都能用。

#### IDE 里的「选择题」为什么要特殊处理

IDE 的交互式选择题（`AskQuestion`）是个死角：它**不触发任何 hook**，也**不结束本轮**，
所以完成卡不会发 —— 人在外面既看不到问题也无法回答，会话就那么静止着。官方 18 个事件里
没有任何一个对应「agent 正在等用户回答」，事后无从补救。

所以本仓库的做法是**绕开它**：往 agent 上下文里注入一条约定，让它需要你做决定时优先调
`ask_user`（发飞书卡片阻塞等你点的 MCP 工具），没有该工具就把选项编号写进正文并结束本轮 ——
问题于是落到完成卡上，那张卡的输入框本来就能远程作答。开关 `CURSOR_STEER_QUESTIONS`（默认开）。

注入走**两个**口子，因为官方支持 `additional_context` 的 agent 事件就这两个：

- `sessionStart` —— 新建会话时打完整版。
- `postToolUse` —— 每次工具调用后，按会话隔 `CURSOR_STEER_REARM_SEC`（默认 30 分钟）
  复读精简版。**这一条是给「已经开着的会话」用的**：`sessionStart` 只在新建会话时触发，
  重开窗口、甚至 Cursor 自升级重启都不会再触发它（实测同一会话 12 次 `stop`、0 次
  `sessionStart`），而且打过的那针也会被上下文压缩丢掉，于是长会话又会退回去弹选择题。

`hooks.json` 和 `mcp.json` 都是热加载的，改完立刻生效，**不用重开窗口**。但两者有个
要紧的区别：hooks 每次事件重新 spawn，天然拿到新代码；MCP 服务是常驻进程，**只改代码
不会让它重启**，要动一下它在 `mcp.json` 里的条目才会换新（升级完记得做这一步）。

`ask_user` 的等待窗口还有一道容易被忽略的坎：Cursor 的 MCP 客户端**连接上 120 秒没动静
就把这次调用判死**（`MCP error -32001`），跟你把总窗口配多大无关。所以等待期间会每
`CURSOR_ASK_HEARTBEAT_SEC`（默认 20 秒）发一次 `notifications/progress` 把它的 idle
计时器顶回去；单次调用另有 60 分钟硬顶，靠 `ask_user_wait` 分段续等绕开。总窗口
`CURSOR_ASK_TIMEOUT_SEC` 默认 24 小时，与完成卡的续写窗口一致。

引导是软约束而非拦截：模型仍可能用选择题，官方没给否决它的口子。此时
`cursor-stall-watch` 看门狗会在静止超过 15 分钟（`CURSOR_STALL_ALERT_SEC`）时发一张
「疑似在等你确认」的提醒卡，叫你回 IDE。那张卡不带输入框 —— 此时没有任何 hook 在等待，
摆一个只会骗人。

#### 用 Remote-SSH 连服务器的会话

**Cursor Remote-SSH 的 agent 运行时整个跑在远程机上，hooks 也在那边执行**，本机的
`~/.cursor/hooks.json` 对这类窗口完全不生效 —— 默认一条飞书都收不到。要让它们发卡，
必须把本仓库和 hook 装到远程机，并在远程 `.env` 里配好 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
（远程 hook 是自己直接发卡的）：

```bash
# 在远程机上（只装只读事件）
npm run cursor:hooks:notify-only
```

远程一律用 `--notify-only`：审批/续写是阻塞链路，要求发卡的 hook 与收回调的 listener 能碰到
同一份决策文件，而 listener 在本机、hook 在远程，碰不上。**也不要在远程再起一个 listener** ——
飞书对同一个 app 的多条长连接是随机投递的，多一个就会随机吞掉你的点击（见「多端共用一个飞书 App」）。

远程机的 `.env` 建议加上 `AGENT_NOTIFIER_MACHINE=<ssh Host 别名>`，卡片落款会显示 `📍 GY_2`，
否则同一个群里本机和几台远程机的卡片分不清是哪台。

---

## 快速开始

### 1. 克隆仓库

```bash
git clone <repo-url>
cd agent_notifier
```

### 2. 配置飞书应用

编辑 `.env`（首次安装会自动从 `.env.example` 创建）：

```bash
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here
# FEISHU_CHAT_ID=
```

> 飞书自建应用创建和审批流程见下方[飞书配置步骤](#飞书配置步骤)。

### 3. 一键安装

```bash
bash install.sh
```

安装脚本会自动完成：
- 检查依赖（必需：Node.js、npm、python3；增强：jq、bun/npx、mutagen — 缺失只警告并给出对应平台安装命令）
- **清理旧配置**（自动调用 `uninstall.sh`）
- 安装 Node.js 依赖
- 从 `.env.example` 创建 `.env`（如不存在）
- 写入 Claude Code hooks 到 `~/.claude/settings.json`
- 写入 Cursor hooks 到 `~/.cursor/hooks.json`（只增删本项目的条目，你自己的 hook 会保留）
- **配置 statusLine**（拷贝跨平台 `scripts/statusline.sh` 到 `~/.claude/`，接入 `cost-capture.js` 抓官方成本/时长/上下文）
- 注入 `claude` / `codex` shell 包装函数（zsh 写 `~/.zshenv`；bash 写 login 文件 `~/.bash_profile`（无则 `~/.profile`）**和** `~/.bashrc` 各一份 — 仅写 `.bashrc` 不够，多数发行版默认 `.bashrc` 对非交互 shell 提前 return，故函数必须直接进 login 文件，保证 `claude-remote-shell` 的 `bash -l -c` 非交互 login 也能拉起 PTY 中继）
- **安装 claude-remote-shell**（从官方仓库拉取脚本到 `~/.local/bin`；mutagen 需另装）
- **自动启动飞书监听器并注册开机自启**

> 重复运行 `install.sh` 是安全的 — 每次会先清理再重新安装。

### 4. 重新加载 shell

```bash
source ~/.zshenv   # zsh：函数已移至 .zshenv（对所有 zsh 加载，含非交互 login）
# 或 source ~/.bashrc
# 最稳妥：重新打开一个终端
```

### 5. 开始使用

```bash
claude
# 或
codex
```

Cursor 不需要包装函数，也不需要重开终端 —— hooks 装好后直接用 Cursor 即可，
任务完成 / 实时摘要的卡片会自动推到飞书（失败的工具是摘要卡里的一步，不再单独发卡）。

### 6.（可选）打开 Cursor 远程控制

通知类开箱即用；**控制类默认关闭**，因为它们会真的把 Cursor 挂住等你拍板 —— 你坐在电脑
前时会莫名卡住（`beforeShellExecution` 对每条命令都触发，包括本来会被自动放行的 `ls`）。

想要远程控制就编辑 `.env`：

```bash
# 在飞书上批准 / 拒绝 Shell 与 MCP 调用
CURSOR_REMOTE_APPROVAL=1
# 强烈建议配 matcher，只对危险命令要审批，否则每条命令都要点一次
CURSOR_APPROVAL_MATCHER=rm\s+-rf|git push|npm publish|kubectl|terraform

# 任务结束后在飞书上直接发下一条指令，Cursor 会自动开下一轮
CURSOR_REMOTE_FOLLOWUP=1
```

然后重跑 `bash install.sh`（`hooks.json` 里的 `timeout` 要跟着超时配置一起更新，
否则 Cursor 会在你还没回应时就把 hook 杀掉）。

---

## 卸载

```bash
bash uninstall.sh
```

卸载脚本会清理：
- 停止并移除飞书监听器服务（launchd / systemd / crontab）
- 终止后台进程（feishu-listener、codex-watcher、codex-session-watcher、pty-relay）
- 从 `~/.claude/settings.json` 移除 hooks
- 从 `~/.cursor/hooks.json` 移除本项目注入的 hooks（你自己的条目不动）
- 从 `~/.zshenv` / `~/.zshrc` / `~/.bashrc` / `~/.bash_profile` / `~/.profile` 移除 shell 函数注入
- 清理运行时文件（session-state、pid、log、/tmp 缓冲文件、决策交汇目录）

> `.env` 和 `node_modules/` 会保留，如需完全清除请手动删除。

---

## 跨平台支持

| 平台 | 服务管理方式 | 开机自启 |
|------|------------|---------|
| macOS | launchd (`~/Library/LaunchAgents/`) | `RunAtLoad` + `KeepAlive` |
| Linux (有 systemd user session) | systemd user service | `systemctl --user enable` |
| Linux (无 systemd，如纯 SSH) | nohup + crontab `@reboot` | crontab 回退方案 |

### 服务管理命令

**macOS:**
```bash
# 查看状态
launchctl print gui/$(id -u)/com.agent-notifier.feishu-listener
# 停止
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.agent-notifier.feishu-listener.plist
# 启动
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-notifier.feishu-listener.plist
```

**Linux (systemd):**
```bash
systemctl --user status agent-notifier-feishu
systemctl --user restart agent-notifier-feishu
journalctl --user -u agent-notifier-feishu -f
```

---

## 配置说明

### `.env` 示例

```bash
# 飞书自建应用
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here
# FEISHU_CHAT_ID=

# 默认宿主（可选）
# DEFAULT_AGENT_HOST=claude
# CODEX_BIN=codex

# 显式指定 tmux pane（可选）
# CLAUDE_TMUX_TARGET=claude:0.0

# 实时摘要（可选，三个宿主共用）
# FEISHU_LIVE_CAPTURE=1
# FEISHU_LIVE_DEBOUNCE_MS=3000

# Cursor 远程控制（默认关闭，见下表）
# CURSOR_REMOTE_APPROVAL=1
# CURSOR_APPROVAL_MATCHER=rm\s+-rf|git push|npm publish
# CURSOR_REMOTE_FOLLOWUP=1

NOTIFICATION_ENABLED=true
# NOTIFICATION_EXPIRE_HOURS=12
# ENABLE_ESC_BUTTON=true
SOUND_ENABLED=true
```

完整可用项见 `.env.example`（里面每一项都注明了为什么这样默认）。

### `FEISHU_LIVE_CAPTURE` 的含义

可选值：
- `1` / `true`：全部开启
- `tools`：工具 / 命令摘要
- `output`：助手输出内容
- `results`：工具执行结果摘要
- 也可以组合：`tools,output,results`

三个宿主共用这一套语义。Codex 的输出来自 `~/.codex/sessions/*.jsonl`，Cursor 的直接来自
hook payload（`postToolUse` 自带 `tool_input` / `tool_output`），都不靠终端文本猜测。

失败的工具（`postToolUseFailure`）就是这张摘要卡里的一步：标题写 `❌` + 失败原因，把
error_message 放在「结果」的位置，卡片头上再挂一个红色的失败计数。它和其他步骤一样**默认折叠**
——报错正文动辄几十行，自动展开只会把整张摘要撑长。**没有独立的失败卡**——每个失败工具发一张
红卡太吵，而直接丢掉这个事件又会让失败的步骤从摘要里凭空消失。

### Cursor 专属配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `CURSOR_NOTIFY_ENABLED` | `1` | 总开关，关掉则 Cursor 相关卡片全不发 |
| `CURSOR_NOTIFY_STOP` | `1` | 任务结束发完成卡 |
| `CURSOR_REMOTE_APPROVAL` | `0` | **远程审批**：飞书上批准 / 拒绝 Shell 与 MCP 调用 |
| `CURSOR_APPROVAL_TIMEOUT_SEC` | `180` | 审批等待上限，超时回落到 Cursor 本地弹窗 |
| `CURSOR_APPROVAL_MATCHER` | 空 | JS 正则，只对匹配的命令要审批（空=全部都问，很吵） |
| `CURSOR_APPROVAL_MCP_MATCHER` | 空 | 只对匹配的 `<服务名>.<工具名>` 要审批 |
| `CURSOR_APPROVE_TOOLS` | 空 | `preToolUse` 网关的工具白名单（需手工加 hook） |
| `CURSOR_REMOTE_FOLLOWUP` | `0` | **远程续写**：任务结束后在飞书发下一条指令 |
| `CURSOR_FOLLOWUP_TIMEOUT_SEC` | `300` | 续写等待上限，超时则本轮就地结束（可设到小时级，见下） |
| `CURSOR_FOLLOWUP_STATUSES` | `completed` | 哪些结束状态才等你续写 |
| `CURSOR_STOP_LOOP_LIMIT` | `50` | 单会话最多自动续写多少轮 |

> ⚠️ 改了任何 `CURSOR_*_TIMEOUT_SEC` 之后要重跑 `install.sh`（或 `npm run cursor:hooks`）
> —— `hooks.json` 的 `timeout` 必须大于我们自己的等待上限，否则 Cursor 会提前把 hook 杀掉，
> 你只会看到"点了没反应"。

#### 想要"隔很久再回话"（小时级等待）

把续写等待调到小时级是支持的，例如 12 小时：

```bash
CURSOR_REMOTE_FOLLOWUP=1
CURSOR_FOLLOWUP_TIMEOUT_SEC=43200   # 12h
NOTIFICATION_EXPIRE_HOURS=24        # 必须大于等待时长，否则卡片会先过期
```

改完跑 `npm run cursor:hooks`（它会同步 `hooks.json` 的 `timeout`，并在
`NOTIFICATION_EXPIRE_HOURS` 配小了时报警）。

这条路上有三个坑已经处理好了，不用你操心，但值得知道它们存在：

- 决策请求会记下自己的截止时间，listener 的按龄清理不会把还在等的请求误删
- 等待方会做存活探测（记 pid + hostname）：你关掉 Cursor 后再点卡片，会明确告诉你
  "本次点击未生效"，而不是假报成功
- 轮询在最初 30 秒后从 120ms 退到 1s，12 小时不会白烧 syscall

**代价**：等待期间该会话一直挂着，IDE 里看起来像还在干活。人在电脑前想立刻收尾，
点卡片上的「结束本轮」即可。

> 如果你要的是「彻底不受这个瞬时窗口限制」，那就用下面的「飞书发起的 Cursor 会话」——
> 那条路没有超时，输入框永远有效。

### Cursor CLI 会话：真正的随时回复

装好并登录 CLI（一次即可，浏览器登录，**不需要 API key**）：

```bash
curl https://cursor.com/install -fsS | bash
~/.local/bin/agent login
```

然后在飞书里发 `cursor`（或在任意卡片的输入框里输 `/cursor`），选一个项目，就得到一个
**由本仓库拥有**的 Cursor 会话：

- 一轮一张卡，执行中流式 patch，结束定稿为绿色完成卡
- 输入框**全程有效**，任何时候回一句就继续下一轮，没有超时
- 执行中发的指令会**排队**，卡片上显示排队条数，本轮结束后自动发出
- footer 带模型与 token 统计

相关配置（都可不填，见 `.env.example`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `CURSOR_AGENT_BIN` | 自动探测 | `agent` 可执行路径。listener 由 launchd 拉起时 PATH 不含 `~/.local/bin`，所以按绝对路径探测 |
| `CURSOR_CLI_MODEL` | 账号默认 | 指定模型 |
| `CURSOR_CLI_FORCE` | `1` | 自动放行工具调用。设 0 会让 agent 停下等批准 —— 无人值守场景等于挂死 |
| `CLAUDE_LAUNCH_DIR` | `~/coderepo` | 项目列表根目录（与 Claude 共用） |

**这条路不解决的事**：它管不到你在 IDE 里手工开的会话（那种只能走上面的 hooks 方案）。
另外飞书发起的会话是 headless 的，agent 没人可问，所以不会再弹选择题 —— 你不会收到
选择卡，但也不会被卡住。

---

## 跨平台部署（macOS / Linux 服务器）

整套流程在 macOS 与 Linux 上行为一致，可在一台 Linux 服务器上独立运行：

```bash
git clone <repo-url> && cd agent_notifier
cp .env.example .env && $EDITOR .env   # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
bash install.sh                        # 一键安装（含 statusLine、claude-remote-shell）
# 重新打开终端，或 source ~/.zshenv（zsh）/ ~/.bashrc（bash）
claude
```

### 三个组件的关系

| 组件 | 角色 | 安装方式 |
|------|------|---------|
| **agent-notifier** | 飞书交互卡通知 + 远程输入回注（本仓库） | `install.sh` 全自动 |
| **ccusage statusline** | 状态栏成本/时长 + `cost-capture.js` 抓官方数据供完成卡显示 | `install.sh` 自动接入跨平台 `scripts/statusline.sh` |
| **claude-remote-shell** | 把 Claude 的 Bash 工具命令 ssh 到远程机执行（可选） | `install.sh` 拉取脚本；mutagen 需另装 |

三者**互不冲突、按层分离**：claude-remote-shell 只重定向 Bash 工具命令，TUI / hooks / statusLine 全在本机运行，agent-notifier 的发卡与回注照常工作。

### 依赖清单

| 依赖 | 必需 | 用途 | 安装（Linux / macOS） |
|------|------|------|---------------------|
| node ≥18、npm | ✅ | 运行时 | `apt install nodejs npm` / `brew install node` |
| python3 | ✅ | pty-relay PTY 中继 | 系统自带 / `brew install python3` |
| jq | 增强 | statusLine 解析时间戳 | `apt install jq` / `brew install jq` |
| bun 或 npx | 增强 | 运行 ccusage | `curl -fsSL https://bun.sh/install \| bash` |
| mutagen | 增强 | claude-remote-shell 文件同步 | [releases](https://github.com/mutagen-io/mutagen/releases) / `brew install mutagen-io/mutagen/mutagen` |

> 增强依赖缺失时 `install.sh` 只警告并打印安装命令，不中断安装。

### Linux 平台说明

- **服务托管**：有 systemd user session 用 `systemctl --user`，否则回退 `crontab @reboot` + nohup
- **终端注入**：Linux 原生走 `/proc` 解析 pts，无需 macOS 的 `ps -o tt=` 分支
- **shell 函数**：zsh 注入 `~/.zshenv`；bash 注入 login 文件（`~/.bash_profile`/`~/.profile`）和 `~/.bashrc` 各一份。⚠️ 仅注入 `.bashrc` 无效——Ubuntu 默认 `.bashrc` 顶部 `case $- in *) return` 非交互即退出，故必须直接进 login 文件，保证 `claude-remote-shell` 的非交互 login 也能拉起 PTY 中继

---

## 飞书配置步骤

### 1. 创建自建应用
登录 [飞书开放平台](https://open.feishu.cn)，创建企业自建应用。

### 2. 获取 App ID / App Secret
在应用后台复制凭证，填入 `.env`。

### 3. 开启机器人能力
在应用能力里启用机器人。

### 4. 事件订阅选择长连接
不需要公网 IP 或域名。

### 5. 添加事件
- `card.action.trigger`

### 6. 申请权限
- `im:message`
- `im:message:send_as_bot`
- `im:chat:readonly`

### 7. 发布应用版本
发布后把机器人加入目标群。

---

## 常用命令

### 安装 / 卸载

```bash
bash install.sh      # 安装（自动清理旧配置 → 重新安装）
bash uninstall.sh    # 卸载（停止服务 → 清理配置）
```

### 飞书监听器（手动管理）

```bash
npm run feishu-listener         # 前台运行
npm run feishu-listener:start   # nohup 后台启动
npm run feishu-listener:stop    # 停止后台进程
```

### Codex 相关

```bash
npm run codex-watcher
npm run codex-watcher:start
npm run codex-watcher:stop
```

### Cursor 相关

```bash
npm run cursor:hooks           # 幂等写入 ~/.cursor/hooks.json
npm run cursor:hooks:remove    # 只移除本项目注入的条目
npm run cursor:e2e:cards       # 真机验证：发全部卡片并真的阻塞等你点
npm run cursor:e2e:approval    # 只验审批链路
npm run cursor:e2e:followup    # 只验续写链路
```

飞书里的入口：

- 发 `cursor`，或任意卡片输入框输 `/cursor` → 弹项目菜单，起一个可随时回话的会话
- 发 `claude`，或输 `/new` → 原有的 Claude 启动菜单

Cursor 只依赖 `feishu-listener` 这一个常驻进程：hooks 由 Cursor 自己按需拉起，
CLI 会话由 listener 按需 spawn。

---

## 架构概览

### Claude 链路
- Claude Hooks 触发事件 → `src/apps/claude-hook.js` 生成卡片 → 飞书监听器接收回调 → 注入回本地终端

### Codex 链路
- `pty-relay.py` 建立终端桥接 → `src/apps/codex-watcher.js` 负责交互卡 → `src/apps/codex-session-watcher.js` 读取 session 文件 → `src/apps/codex-live.js` 负责实时摘要卡

### Cursor 链路 A：hooks（管 IDE 里的会话）

走的是「阻塞式 hook + 决策交汇点」，全程不碰终端：

```
Cursor ──事件 JSON──▶ cursor-hook-handler.js
                          │
                          ├─ 发飞书卡（审批 / 完成）
                          ├─ 在 /tmp/agent-notifier-decisions 登记待决策请求
                          └─ 阻塞等待……
                                       ▲
你在飞书上点一下 ──▶ feishu-listener ──┘ 写入裁决
                          │
Cursor ◀──stdout JSON──────┘  permission: allow/deny/ask
                              followup_message: "下一步做这个"
```

- 事件翻译：`src/adapters/cursor/hook-adapter.js`
- 控制策略（开关、matcher、超时回落）：`src/adapters/cursor/control-policy.js`
- 卡片：`src/apps/cursor-cards.js`，主流程：`src/apps/cursor-hook.js`
- 实时摘要：`src/apps/cursor-live.js`（轮次边界用 `generation_id`，同轮 patch 同一张卡）
- 交汇点：`src/lib/decision-bridge.js`（固定落在 `/tmp`，因为 macOS 的 `TMPDIR`
  是按会话分配的，IDE 拉起的 hook 与 launchd 拉起的 listener 会拿到不同目录）

### Cursor 链路 B：cursor-agent CLI（管飞书发起的会话，可随时回话）

```
飞书发 cursor / 输 /cursor
        │
        ▼
 listener 列项目 → 自己生成 UUID 作会话 id → 存进 session-state
        │
        ▼
 agent -p --trust --resume <uuid> --workspace <proj> --output-format stream-json "<指令>"
        │
        ├─ stream-json 事件流 → 一轮一张卡，节流 patch
        └─ result 事件      → 定稿为绿色完成卡，输入框保留

任意时刻在输入框回话 → 同一个 uuid resume → 上下文完整延续（无超时）
执行中回话           → 排队，本轮结束后自动发出
```

- CLI 封装与 stream-json 解析：`src/adapters/cursor/cli-session.js`
- 会话生命周期、排队、卡片编排：`src/apps/cursor-cli.js`
- 关键点：会话 id 由我们生成（CLI 对未知 id 会静默新建，正好被利用成「从诞生起就拥有」）；
  子进程强制 `CURSOR_NOTIFY_ENABLED=0`，否则同一轮会既发 CLI 卡又发 hook 卡

### 终端注入方式（仅 Claude / Codex）

飞书输入想要真正送回 Claude / Codex，本项目支持多种方式：

| 方式 | 场景 |
|------|------|
| tmux | 推荐，在 tmux 会话中运行 `claude` / `codex` |
| PTY 代理 | 非 tmux 环境，`pty-relay.py` 自动建立 FIFO 注入通道 |
| 显式指定 tmux pane | `CLAUDE_TMUX_TARGET=claude:0.0` |

注入优先级：`CLAUDE_TMUX_TARGET` > 自动检测 tmux pane > FIFO 中继 > pty master 直写 > TIOCSTI 备用

### Hook 配置

使用 `install.sh` 会自动完成。

**Claude** 写入 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js" }] }],
    "Notification": [{ "matcher": "permission_prompt|idle_prompt|elicitation_dialog", "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "node /path/to/hook-handler.js" }] }],
    "PostToolUse": [{ "matcher": "Bash|Write|Edit|NotebookEdit", "hooks": [{ "type": "command", "command": "node /path/to/live-handler.js" }] }]
  }
}
```

**Cursor** 写入 `~/.cursor/hooks.json`（`timeout` 由 `.env` 里的超时配置算出来，
必须大于我们自己的等待上限）：

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "node /path/to/cursor-hook-handler.js", "timeout": 210 }],
    "beforeMCPExecution":   [{ "command": "node /path/to/cursor-hook-handler.js", "timeout": 210 }],
    "stop":                 [{ "command": "node /path/to/cursor-hook-handler.js", "timeout": 330, "loop_limit": 50 }],
    "afterAgentResponse":   [{ "command": "node /path/to/cursor-hook-handler.js", "timeout": 30 }],
    "postToolUse":          [{ "command": "node /path/to/cursor-hook-handler.js", "timeout": 30, "matcher": "Shell|Write|StrReplace|Edit|Delete|EditNotebook" }],
    "postToolUseFailure":   [{ "command": "node /path/to/cursor-hook-handler.js", "timeout": 30 }]
  }
}
```

`preToolUse`（按工具名网关）和 `subagentStop`（子代理续写）也已实现，但默认不注册 ——
它们对每个工具调用 / 每个子代理都触发，太吵。需要时手工加进上面这份配置。

---

## 验证与联调

```bash
# 跑测试
bun test tests/
python3 -m py_compile pty-relay.py

# 发测试卡
node scripts/send-codex-feishu-test-cards.js --pts /dev/pts/<N>
npm run ask:e2e:card
npm run cursor:e2e:cards       # Cursor：真的阻塞等你点，点一下就验完整条链路
```

建议至少手动验证：
- Claude 完成卡发送是否正常
- Codex 文本输入 / 审批 / 单选 / 多选是否都能回流
- Codex live 卡是否同任务 patch、新任务 create
- Cursor 审批卡点「允许 / 拒绝」后，Cursor 那边是否真的放行 / 拦下，原卡是否收敛成「已处理」
- Cursor 完成卡里回一句话，Cursor 是否自动开了下一轮
- 长文本是否被正确分块

Cursor 专项检查（改了 `cursor-hook.js` 必做）：

```bash
# stdout 是给 Cursor 读的裁决通道，必须只有纯净 JSON
node cursor-hook-handler.js < tests/fixtures/cursor/stop.json 2>/dev/null | od -c
# 期望：{  }  \n  ——多任何一个字节，Cursor 都会把整段输出判为无效 JSON
```

---

## 注意事项

- PTY raw mode 下 Enter 是 `\r`，不是 `\n`（仅 Claude / Codex 的注入路径）
- 完成类卡片会带输入框，方便直接续聊
- `im.message.patch` 会丢失输入框，所以完成卡通常新建，执行中卡使用 patch
- Cursor 的实时摘要卡**故意不带输入框** —— 运行中的 Cursor 没有可回流的输入通道，
  唯一入口是任务结束时的完成卡，摆个点了没反应的输入框只会骗人
- Cursor 的一切等待都有超时兜底，绝不会把 Cursor 永久挂住
- 同一个飞书应用只能有**一个** listener 在线，多开会导致回调被随机分发（表现为随机「已过期」）
- 敏感配置放在 `.env`，不要提交

---

## 开发说明

如果你是来二次开发的，优先看：
- `docs/ai_rules.md`
- `docs/ai_docs/README.md`
- `src/apps/claude-hook.js`
- `src/apps/codex-live.js`
- `src/apps/codex-watcher.js`
- `src/apps/cursor-hook.js` + `src/lib/decision-bridge.js`（Cursor 阻塞式控制的核心）
- `src/channels/feishu/feishu-interaction-handler.js`

---

## License

[MIT](./LICENSE)
