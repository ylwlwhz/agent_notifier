# AI 开发规则

## 1. 文档与语言

- 本项目 AI 相关文档、对话、代码注释、CLI 输出、提交信息统一使用中文。
- 代码标识符、目录名、脚本名保持英文。
- 面向 AI 的说明优先写在 `docs/ai_rules.md` 与 `docs/ai_docs/`，避免把关键背景只放在聊天记录里。

## 2. 当前支持范围

本仓库当前支持三个交互宿主：

- `Claude`：基于 hooks 的本地集成，回流靠 PTY 注入
- `Codex CLI`：基于本地终端会话与 session 文件的集成，回流靠 PTY 注入
- `Cursor`：基于 Cursor 官方 hooks 的集成，回流靠**阻塞式 hook 返回值**，不碰终端

当前明确不支持：

- `codex_app` 云端任务模式

### 三个宿主的机制差异（改动前必读）

| | Claude | Codex | Cursor |
|---|---|---|---|
| 事件来源 | Claude hooks（stdin JSON） | PTY 输出 + `~/.codex/sessions/*.jsonl` | Cursor hooks（stdin JSON） |
| 回流通道 | PTY / tmux 注入按键 | PTY / tmux 注入按键 | **hook 的 stdout 返回 JSON** |
| 需要 pty-relay | 是（非 tmux 时） | 是（非 tmux 时） | **否** |
| 需要 shell 包装函数 | 是（`claude()`） | 是（`codex()`） | **否** |
| 通知记录里的 `pts_device` | 必有 | 必有 | **恒为 null** |
| 失败模式 | 注入丢字符 / 序列错乱 | 同左 | 无注入，只有「等不到人」 |

**关键点：Cursor 的 hook 是阻塞式进程** —— Cursor 把事件 JSON 写进 hook 的 stdin，然后
**等** hook 在 stdout 上给出裁决（`permission` / `followup_message`）。所以 Cursor 的远程控制
不需要猜终端、不需要注入按键、也不存在「按键被吞」这类问题；代价是必须自己保证
**永不把 Cursor 永久挂住**（见 §4 Cursor 小节）。

## 3. 代码结构约束

- 新的运行时代码统一放在 `src/` 下。
- 仓库根目录脚本只保留轻量入口，不要继续堆业务逻辑：
  - `hook-handler.js`
  - `ask-handler.js`
  - `live-handler.js`
  - `cursor-hook-handler.js`
  - `feishu-listener.js`
- 宿主专属逻辑分层放置：
  - Claude 相关适配放在 `src/adapters/claude`
  - Codex 相关适配放在 `src/adapters/codex`
  - Cursor 相关适配放在 `src/adapters/cursor`
- 飞书通道层统一放在 `src/channels/feishu`
- 各宿主运行态应用统一放在 `src/apps`
- 所有飞书卡片都必须带宿主身份，至少能区分 `Claude` / `Codex` / `Cursor`
  （`HOST_LABELS` 在 `src/lib/card-footer.js`，`HOST_META` 在 `feishu-card-renderer.js`，
  「已收到」卡的 `HOST_TAGS` 在 `src/apps/feishu-listener.js`——新增宿主要一起加）
- 旧卡片不能因为新卡片出现而被无条件废弃；交互卡要靠超时、提交、取消来收敛
- **宿主判定一律写白名单，不要写「!== 某宿主」**。历史教训：`_claudeSessionKey` 原本判
  `!== 'codex'`，新增 cursor 宿主后立刻误写出 `received_msg_cursor_x` 这种永不被消费的键。

## 4. 各宿主链路约束

### Claude

- Claude 的实时摘要基于 hook 事件与 transcript
- `FEISHU_LIVE_CAPTURE` 语义来源于 Claude 的实现，是全项目的基准语义

### Cursor

- Hook 注册在 `~/.cursor/hooks.json`（用户级），由 `scripts/setup-cursor-hooks.js` 幂等写入；
  install.sh 会调它，uninstall.sh 用 `--remove` 只删本仓库注入的条目
- 注册哪些事件**由 `.env` 里的策略决定**，不是写死的：只读事件（`sessionStart`、
  `afterAgentResponse`、`postToolUse` / `postToolUseFailure`、`afterAgentThought`、
  `subagentStart`）恒装；`beforeShellExecution` / `beforeMCPExecution` 只在
  `CURSOR_REMOTE_APPROVAL=1` 时注册；`stop` 的超时按 `CURSOR_REMOTE_FOLLOWUP` 取长/短。
  **别改成「一律装全」**：阻塞事件在策略关闭时照样会被调用（hook 只是立刻回空对象），
  进程该起还是要起，网络文件系统上那是每条命令 1~2s 的白付开销。
  `--notify-only` 是显式覆盖，供「listener 不在本机」的机器用——那种情况下阻塞链路
  没人接，`.env` 怎么写都必须退回只读。
  `preToolUse` / `subagentStop` 有实现但从不注册（对每个工具/子代理都触发，太吵）
- 事件翻译在 `src/adapters/cursor/hook-adapter.js`，控制策略在 `control-policy.js`，
  卡片在 `src/apps/cursor-cards.js`，主流程在 `src/apps/cursor-hook.js`
- 轮次边界用 `generation_id`（官方语义「每条用户消息都会变」），不要用 `conversation_id`
  （跨轮不变）也不要靠文本猜

#### Cursor 的四条硬约束（每条都对应一个真实故障）

1. **stdout 是裁决通道，必须绝对纯净。**
   `cursor-hook.js` 的 `protectStdout()` 把 `process.stdout.write` 整体改道 stderr，
   只留 `emit()` 一个出口。只改 `console.log` 不够——实测飞书 SDK 用 `console.info` 打
   `[info]: [ 'client ready' ]`，env-config 用 `console.log`，dotenv 还有自己的提示。
   任何一行混进 stdout，Cursor 都会把整段输出判为无效 JSON，`failClosed` 时等于直接拦下用户操作。
   **改动后务必字节级验证**：`node cursor-hook-handler.js < fixture.json 2>/dev/null | od -c`
   应当只有 `{}\n`。
2. **绝不把 Cursor 永久挂住。** 一切等待都有超时，超时后必须回落到宿主本地行为：
   审批回 `permission:'ask'`（Cursor 自己弹窗），续写回 `{}`（本轮就地结束）。
   发卡失败、没有飞书凭证、未开控制开关——这三种情况都要**立刻**回 `{}`，不能进等待。
3. **只输出该事件支持的字段**（`renderHookOutput` / `ALLOWED_OUTPUT_FIELDS`）。多余字段
   会让 Cursor 侧校验失败，落进「hook 返回无效 JSON」分支。
   注意 `preToolUse` 的 `permission:'ask'` 官方明确「schema 接受、当前不生效」，
   所以它超时回空对象而不是 `ask`。
4. **hooks.json 的 `timeout` 必须大于我们自己的等待上限。** 否则 Cursor 会在飞书还没人
   回应时就把 hook 杀掉，用户只看到「点了没反应」。`setup-cursor-hooks.js` 读 `.env` 里的
   `CURSOR_*_TIMEOUT_SEC` 自动 +30s 余量——**改完超时配置必须重跑 install.sh**。

#### 决策交汇点 decision-bridge

发卡的是短命 hook 进程，收回调的是长驻 listener 进程，两者靠
`src/lib/decision-bridge.js` 会合（文件形式，`/tmp/agent-notifier-decisions`）：

```
hook:     open(id) → 发飞书卡 → wait(id, timeout)  ──┐
listener: 收到卡片回调 → resolve(id, decision)     ──┘ → hook 读到裁决 → 打印给 Cursor
```

- **目录固定用 `/tmp`，不能用 `os.tmpdir()`**（`src/lib/tmp-dir.js`）。macOS 的 TMPDIR 是
  按会话分配的（`/var/folders/xx/…/T/`），Cursor 拉起的 hook 与 launchd 拉起的 listener
  会拿到两个不同目录，双方各写各的、永远等不到对方。
- 回复走 tmp+rename 原子落盘，读侧不会读到半截 JSON。
- `resolve()` 返回 `false` 表示无人在等（已超时 / 已在 IDE 里处理 / hook 进程已死），
  listener 必须**如实**告诉用户「本次点击未生效」，不能假报成功。
- 重复 `resolve()` 只认第一次，避免两次点击互相覆盖。
- 空裁决 `{}` 是合法裁决（「结束本轮」就是不给 `followup_message`），判定时不能用真值判断
  把它当成超时。

#### 长等待（小时级）的三条额外约束

把 `CURSOR_FOLLOWUP_TIMEOUT_SEC` 调到小时级（例如 12h = 43200）是支持的，但下面三条
每一条都对应一个「短等待时看不出来、长等待必然踩到」的坑：

1. **清理必须尊重 hook 自己声明的截止时间。** `open()` 会把 `timeoutMs` 换算成 `expires_at`
   落盘，`cleanExpired()` 按 id 成对处理并跳过未到期的请求。
   早期版本只按 mtime 删（阈值 30 分钟），12h 等待会在第 30 分钟被误删 ——
   用户几小时后点卡片被告知「无人在等」，而 hook 其实还在等。
   **同理：清理必须按 id 成对，不能逐文件删**，只删走 reply 会让等待方饿死。
2. **`NOTIFICATION_EXPIRE_HOURS` 必须大于最长等待。** 否则 listener 的通知过期清理会先把
   这条通知删掉，用户在等待窗口内点卡片却看到「卡片已过期」。
   `setup-cursor-hooks.js` 会在配错时打印警告。
3. **要做等待方存活探测。** `open()` 记 `pid` + `hostname`，`resolve()` / `isPending()` /
   `cleanExpired()` 用 `process.kill(pid, 0)` 判断 hook 是否还活着。
   没有它的话，关掉 Cursor 窗口后请求文件还会「有效」12 小时，用户点了会收到假成功。
   只在 `hostname` 相同时才判断 —— 远程工作区里 hook 与 listener 可能不同主机，
   pid 没有可比性，那种情况一律按「还活着」处理，退回超时兜底。

另外，`wait()` 的轮询会在最初 30s 后从 120ms 退到 1s：12h 全程 120ms 轮询是几百万次
无谓 syscall，而 1s 的响应差异人感知不到。改轮询逻辑时别把这个退避去掉。

代价要跟用户讲清楚：等待期间该会话一直挂着，IDE 里看起来像还在干活；人在电脑前想立刻
收尾就点卡片上的「结束本轮」（它 resolve 一个空裁决）。

4. **同一会话同时只能有一张待回复的卡。** 长窗口下每轮结束都会留下一个阻塞的 hook 进程
   和一张永久有效的卡，实测四小时里攒到 **9 个**。进程泄漏之外更糟的是：用户回复某张旧卡，
   续写会被注入到几小时前就结束的那一轮里。所以 `askFeishu` 开新请求前会调
   `supersedePrevious()`，用 `decisionBridge.listPending({sessionId, event})` 找出上一轮
   遗留的请求，写入 `{superseded:true}` —— 老 hook 自己醒来、把卡片收敛成
   「已被新一轮取代」、再正常退出。**别改成直接杀进程**：那样卡片永远停在可点状态。

#### hooks 能力边界（实测结论，别再重复试）

以下都是在真机上挂探针 hook 逐个验证出来的，不是推断：

- **`AskQuestion`（选择题工具）既不触发 `preToolUse` 也不触发 `postToolUse`。**
  2026-08-26 实测：挂无 matcher 的探针，`preToolUse` 抓到 4 次 `Shell`、`postToolUse` 抓到
  1 次 `Shell`，期间调用了 3 次 `AskQuestion`，一次都没出现。它是客户端 UI 交互，
  不作为「工具执行」经过 hook 链路。
  **推论：选择题的远程作答在 hooks 层做不到**，不用再找 matcher 写法或事件组合。
- **`preToolUse` 没有「提供工具结果」的输出字段**（只有 `permission` / `user_message` /
  `agent_message` / `updated_input`）。即使某个工具能被拦下，也只能「拒绝 + 把答案当
  `agent_message` 交给 agent」，无法像 Claude 那样把答案真正喂给那个工具。
- **往 IDE 里已存在的会话注入用户消息，唯一入口是 `stop` 的 `followup_message`**，
  而它只在一轮结束的那一瞬间存在。所以「随时从卡片回复」在 hooks 层同样做不到。
- **没有任何事件对应「agent 正在等用户回答」。** 官方 18 个 agent 事件逐个核过
  （`sessionStart/sessionEnd`、`beforeSubmitPrompt`、`preCompact`、`afterAgentThought`、
  `subagentStart/Stop`、`before/afterShellExecution`、`before/afterMCPExecution`、
  `beforeReadFile/afterFileEdit`、`pre/postToolUse(+Failure)`、`stop`），没有一个是这个语义。
- **transcript 也救不了它，两处硬伤。** ① 工具调用与其入参【不入】transcript——用一次
  AskQuestion 的选项 id 去搜当轮 transcript，0 命中；② transcript 是【按轮次末尾】落盘的
  （实测文件 mtime 落后当前时间半小时），等它写出来问题早过去了。所以「盯 transcript
  实时提醒」这条路不要再试。

**根本原因（这条决定了架构上限）**：hooks 是**旁路观察者 + 否决者**，不是输入通道。
Claude/Codex 能随时回是因为终端里有个活着的 TUI 停在提示符前，可以灌字节；
Cursor 的 composer 是 GUI，没有等价物。要突破这个上限，必须让**会话的所有权翻转** ——
由本仓库自己拥有会话，而不是去够 IDE 里那个。

#### 选择题的正解：用 MCP 工具承载「远程作答」

hooks 拦不住选择题，但 **MCP 工具调用是有返回值的** —— 于是可以由我们自己的进程阻塞着等
飞书那边点一下，再把答案作为工具结果交回 agent。不需要「deny + agent_message」那种歪招，
agent 拿到的就是一次正常的工具结果。这是官方通道里唯一能承载这件事的一条。

实现是 `src/apps/cursor-ask-mcp.js`（零依赖手写 stdio JSON-RPC，只实现
`initialize` / `tools/list` / `tools/call` / `ping`），注册见 `scripts/setup-cursor-mcp.js`。
工具名 `ask_user(question, options?, context?)`。

**关键约束与坑：**

- **单次调用的超时上限是硬的，长等待必须靠分段续等。** IDE 里 `tools/call` 约 60 分钟；
  CLI / ACP 那条路是**硬编码 60 秒**，且 `notifications/progress` 不会续期（官方论坛已确认
  是 TS SDK 的已知问题）。所以设计成：总窗口 `CURSOR_ASK_TIMEOUT_SEC`（默认 12 小时），
  单段 `CURSOR_ASK_CHUNK_SEC`（默认 50 分钟）；每段到点若还没答案就返回 `pending_id`，
  要求 agent 立刻调 `ask_user_wait` 继续等 —— 单次调用永不触碰上限。
  别把单段贴着 60 分钟调，撞上时 Cursor 报 `MCP error -32001`，用户只看到「工具失败」。
- **分段之所以安全，是因为裁决走的是【文件】而不是活的通道**：用户在两段之间回答，答案
  落盘，下一段 `wait()` 读文件照样拿到。所以段间**绝不能**收敛卡片或关掉决策通道 ——
  那才会真的丢答案。
- **续等指引的措辞必须是「下一步就做这个」**。含糊的话 agent 会自己往下跑，用户几小时后
  点了卡片却没人接。同时要给出「不想等了就正文提问」的另一条明路。
- **别用 MCP 的 elicitation 机制**（服务端反向向用户要输入）：那个超时约 60 秒且不可配，
  官方已确认是限制。要阻塞就阻塞在 `tools/call` 里。
- **stdout 是协议通道**，与 hook 同一个坑。`protectStdout()` 必须只在【作为主模块运行时】
  调用：放在模块顶层会在被 `require` 时劫持宿主进程的 stdout（实测把 `node --test` 的
  报告输出搅成乱码）。
- **回流通路一行都没改。** 卡片按钮沿用 Claude 选择卡那套 action_type（`opt_N` /
  `text_input` / `interrupt`），notification 里照常放 `responses` + `text_response`，
  listener 的 `_cursorDecisionFor` 直接就认。加新交互时照这个形状来，别去改 listener。
- **任何异常路径都必须给 agent 一段可执行的指引**（没凭据、发卡失败、超时都一样）：
  告诉它「把选项编号写进正文并结束本轮」。空手而归的话它只会重试或干等，
  用户在手机上还是什么都拿不到。

降级链是刻意设计的：`ask_user`（50 分钟，按钮直接点）→ 超时后正文列选项 + 结束本轮
（完成卡输入框，可达 24 小时）→ 都没人应就 `stop` 就地收尾。

写测试时注意：`askUser` 内部会 `require` env-config，它调 `dotenv` 重新加载 `.env`，
而 dotenv 只跳过【已存在】的键。所以用例里要把凭据**置空**而不是 `delete` ——
delete 掉会被重新灌回来，用例就会真的发卡到飞书并阻塞几十分钟（实测踩过）。

#### 兜底：把提问引导成「正文 + 结束本轮」

既然选择题事后无从补救，就别让 agent 走到那一步。`sessionStart` 是唯一能改变 agent
行为的官方注入点——它的输出字段 `additional_context` 会进「会话的 initial system context」。

于是 `handleSessionStart` 默认注入一条约定（`QUESTION_STEER_CONTEXT`）：需要用户在若干
方案之间做决定时，把选项编号写进正文并结束本轮。这样问题就落在 `stop` 卡上，而那张卡的
输入框是我们完全掌控的链路——**把一个不可观测的交互，换成了一个已经跑通的交互**。

约束与注意：

- 只对**新建**会话生效。已经开着的会话不受影响，改完要新开窗口才见效。
- 官方明说 `sessionStart` 是 fire-and-forget、不阻塞 agent loop，所以别在这个 hook 里做
  任何耗时的事（发卡、等飞书都不行），拿到就回。
- `is_background_agent` 为真时不注入：背后没人盯着 IDE。
- 开关 `CURSOR_STEER_QUESTIONS`（默认开）。关掉就等于承认选择题永远无法远程作答。

兜底是 `cursor-stall-watch` 看门狗。选择题是**零事件**状态，唯一可观测的信号只有沉默，
但沉默本身不足以判定——一条十分钟的编译命令同样是十分钟沉默。所以判据多了一条：

> 最后一个事件必须属于 `WORK_EVENTS`（`postToolUse` / `postToolUseFailure` /
> `afterAgentThought` / `afterAgentResponse`）——「刚干完一件事，理应马上有下一步」。

**写成允许清单而不是排除清单**，因为排除法会把两类正常状态误判成卡死：活儿正在跑
（`beforeShellExecution` / `beforeMCPExecution` / `subagentStart`，干完自然有 `postToolUse`）、
以及**开了新窗口却还没使唤它**（`sessionStart`）。后者实测真的误报过：每个空窗口 3 分钟后
都收一张「疑似在等你确认」。允许清单还是安全的默认——以后为刷心跳再注册什么观测类事件，
都不会自动变成告警源。

代价是宁可漏报：agent 在一轮开头就直接弹选择题、期间既无思考事件也无工具调用时检测不到。
这个取舍是刻意的，因为这张卡能提供的信息本来就有限（见下）。

三个坑，改这里之前必须知道：

- **别把判据写成「最后事件必须是 `afterAgentResponse`」。** 实测 `afterAgentResponse`
  只在**一轮结束时**触发（一轮里几十条助手消息都不会触发它，本会话验证过），而卡在选择题
  的那轮永远不会结束——那样写等于永远不告警。
- **`afterAgentThought` / `subagentStart` 是为看门狗注册的**，本仓库不处理它们的内容
  （`kind=ignore`）。所以 `trackActivity` 必须在 handler 分流【之前】调用，否则这两个事件
  会在 `if (!handler) return` 处被丢掉，长思考与长子代理就会被误报成卡死。别当成无用注册删掉。

- **抢锁必须原子。** `ensureWatcher` 用 `open(..., 'wx')` 独占创建锁文件，只有创建成功的
  进程才 spawn。hook 是每个事件一个独立进程，「先读锁发现没有 → 再 spawn → 再写锁」中间的
  窗口实测真的抢出过**同一会话两个看门狗**（后果是重复告警）。看门狗退出时只删 pid 属于
  自己的那把锁，否则会把新看门狗的锁误删。

**阈值默认 15 分钟，别再调小。** 实测踩过：3 分钟会在正常长回合里误报 —— agent 组织一段
长回复、或做一次大上下文思考时【什么事件都不产生】，文字要到轮末的 `afterAgentResponse`
才有信号。这个兜底的价值本来就随 `ask_user`（MCP 提问工具）的落地大幅下降了，
宁可漏报也不该在人干活时乱叫。另有一条抑制规则：`hasPendingCard(sessionId)` 为真时不告警
—— 用户手上已经有可操作的卡，多一张「疑似卡住」只是噪音。

告警卡**刻意不带交互组件**：这张卡发出时没有任何 hook 在等待，摆输入框是骗人。

**这张卡的价值要说实话**：它只能把「静默挂着」变成「你知道它挂了」。它给不出问题内容
（`afterAgentResponse` 只在轮末触发，静止期间没有正文落盘），对只能远程访问的人来说是条
死路——真正的解法是上面那条 `sessionStart` 引导（已实测生效），这张卡只是极少见时的兜底。

#### Remote-SSH：agent 运行时在【远程机】上（实测结论）

用 Cursor 的 Remote-SSH 连到服务器干活时，**agent 运行时整个跑在远程那台机器上，hooks
也在那边执行**。本机 `~/.cursor/hooks.json` 对这类窗口完全不生效——所以远程会话默认
一条飞书都收不到，而且从本机看不出任何异常。

证据（2026-08-26 在真机上验证）：

- 远程 `~/.cursor/` 里有 `projects/<远程工作区>/terminals/*.txt`、`skills-cursor/`、
  `ide_state.json`（内容全是远程绝对路径），时间戳与会话同步刷新
- 在远程装一个 fail-open 探针 hook，**不需要 Reload 就立刻命中**，抓到的 `stop` payload 里
  `workspace_roots` 是远程路径、`transcript_path` 也在远程

因此：

1. **远程会话要收通知，必须把本仓库和 hook 装到远程机**，并让远程 `.env` 具备
   `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（远程 hook 是自己直接发卡的）。
2. **远程一律用 `--notify-only`。** 审批/续写是阻塞链路，它们要求「发卡的 hook」与
   「收飞书回调的 listener」能碰到同一份 decision-bridge 文件；listener 在本机、hook 在
   远程，碰不上。装上阻塞事件只会让远程每条命令都白等一次超时。
3. **绝不能在远程再起一个 listener 来「就近处理」。** 飞书对同一个 app 的多条长连接是
   【随机】投递的，多一个 listener 就会分走一部分点击并用它自己的 state 作答，表现为随机
   「卡片已过期」（同 §11.4，`warnRivalListeners` 那段注释）。
4. **卡片必须标出机器名。** 同一个群会同时收到本机和多台远程机的卡片，
   落款靠 `AGENT_NOTIFIER_MACHINE`（`buildCardFooter` 的 `machine` 参数，渲染成 `📍 GY_2`）。
   不配就不显示，本机卡片保持原样。

远程要做到「能从卡片作答」，需要把 decision-bridge 跨机化：卡片 value 里带上 origin 主机
别名，本机 listener 收到回调后不自己裁决，而是 ssh 转交给远程副本里的 relay，由远程读它
自己的 state、算裁决、写它自己的 bridge（本机 listener 退化成纯传输层）。这条尚未实现。

##### 远程机的两个坑（都实测踩过）

**1. 出网必须走代理的机器上，Lark SDK 的传输层会静默挂住。**
症状分两段：先是发卡报 `Cannot destructure property 'tenant_access_token'`（连不上鉴权
接口），把飞书域名从 `no_proxy` 里放出来（`FEISHU_FORCE_PROXY=1`）之后变成**挂住**——
hook 打完 `client ready` 就再无输出，最后被 hook 超时杀掉。SDK v1.60 内部取 token 走了
外部够不到的传输路径，构造传 httpInstance / 全局拦截器都无效。

所以 `createLarkHttpClient()` 会在 `FEISHU_FORCE_PROXY=1` 时换成 `axios-lark-client.js`
那个 shim（显式 `HttpsProxyAgent` + `proxy: false`，只实现用到的三个方法）。
**任何发卡入口都必须走这个工厂，不要各自 `new Lark.Client`** —— 有单测钉着这条纪律
（`tests/channels/lark-http-transport.test.js`），因为漏一处就又是一次静默挂死。

排查这类问题别只 curl 首页：`https://open.feishu.cn/open-apis/authen/v1/index` 直连会回
302，看着像通的，实际上鉴权接口 `POST /open-apis/auth/v3/tenant_access_token/internal`
直连返回 000、走代理才 200。要测就测鉴权接口。

**2. 往远程 rsync 时不要用 `-a`，它会把远程仓库的 git 弄坏。**
`-a` 含 `-o`/`-g`，接收端是 root 时会把文件属主改成本机 uid（远程根本没有这个 uid），
git 随后一律拒绝工作：`fatal: detected dubious ownership`，连 `git config user.name`
都读不出来。正确写法：

```bash
rsync -rlptD --no-owner --no-group --exclude='.git/' --exclude='.env' \
      --exclude='node_modules/' --exclude='*.log' --exclude='*.pid' ./ HOST:/path/
```

已经坏了就 `chown -R root:root <repo>` 修回来。另外 rsync 多个源文件到一个目录时要写全
目标路径 —— `rsync a/b/c.js x.example HOST:/repo/` 会把 `c.js` 丢到仓库根，成为一个
谁都看不出来处的野文件。

**在远程仓库切分支前先查「这个分支有没有那台机器的专用文件」。**
那台机器出网必须走公司代理、SSH 直连不通，靠 `~/.ssh/config` 把 `github.com` 指到
`ssh.github.com:443` + `bin/proxy-connect.py`（零依赖的 HTTP CONNECT 隧道，机器上
nc/ncat/socat/corkscrew 全缺）打隧道。这个脚本原先只在 `tencent` 分支上，`git checkout`
到别的分支会把它删掉 —— 症状是 git 突然「没有权限或仓库不存在」，
真实原因藏在 `ssh -T git@github.com` 的第一行：`python3: can't open file ...`。
现在它已并入本分支，别再把它当成无关文件删掉。

**3. hook 的模块加载时间就是用户干等的时间。**
远程仓库在网络文件系统（CephFS）上，实测 `require` 一次 Lark SDK 要 **12.6s**、axios 要
5.7s，而 node 空启动只有 0.15s。同步发一张完成卡曾经要 17s —— 每轮结束都卡这么久。

两条对策，都别退回去：

- `feishu-client.js` 里 Lark SDK 是**惰性 require** 的，走 shim 的机器不为用不到的 SDK 付钱
- 纯通知卡（完成卡 / 失败卡）走 `sendCardDetached()` → `cursor-send-card.js` 子进程，
  hook 立刻返回。**需要事后收敛卡片的链路（审批 / 等续写）不能这么做**，它们要 message_id。

改完后：只刷心跳的事件 ~1.9s，发完成卡 ~1.8s。发卡失败会记到
`/tmp/cursor-send-card-error.log`（子进程 stdio 是 ignore 的，不留痕就查不到）。

### 4.x cursor-agent CLI 实测结论（2026-08-26）

为「随时从卡片回复」验证过 `cursor-agent`（版本 `2026.08.11-e8db854`），结论如下。
**这些都是真机实测，别再重复验证：**

可用的：

- `agent -p --trust --resume <id> --workspace <dir> --output-format json "消息"`
  **非交互可用，上下文完整保留**，单次往返约 10–20s。这就是「随时往已有会话推消息」的原语。
  证据：resume 自己创建的会话时 `inputTokens: 186 / cacheReadTokens: 13440`（历史已加载）。
- CLI 用自己的登录（`agent login`，浏览器流程），**不需要 `CURSOR_API_KEY`**，
  也**不复用桌面端登录态**（首次 `agent status` 会报 `Not logged in`）。
- `--mode ask` 是只读的，做验证时用它，不会改文件。

不可用 / 反直觉的：

- **`--resume` 传 IDE 创建的会话 id 拿不到任何历史。** 用一个有真实内容的 IDE 会话验过，
  agent 明确回「无历史」，且 `inputTokens: 11298 / cacheReadTokens: 2176`（只有系统提示）。
  **CLI 与 IDE 的会话是两个命名空间**，CLI 只能接管自己创建的会话。
- **`--resume` 传不存在的 id 不报错，而是用那个 id 静默新建一个会话。**
  拿随机 UUID 验过。设计上要小心：id 记错会静默分叉出新对话而不是响亮失败。
  反过来看这也是个可利用的特性 —— 可以自己生成 UUID，从诞生起就拥有该会话。
- **`agent ls` / `agent create-chat` 在非 TTY 下会挂住**（`ls` 是交互式选择器，无任何
  非交互选项），无法脚本化。但不影响设计：会话 id 我们自己生成或从 hook 拿，不需要枚举。
- 未受信任的工作区会直接拒绝执行，脚本化时必须带 `--trust`。
- CLI 本地不存会话（`~/.local/share/cursor-agent` 只有 `versions/`），会话在服务端；
  但 transcript 会落到 `~/.cursor/projects/<slug>/agent-transcripts/<id>/`，
  与 IDE 会话**同一套磁盘布局**（所以「布局相同」不能推出「命名空间相同」）。

### 4.x Cursor CLI 会话（飞书发起，可随时回复）

基于上面的实测结论落地的第二条 Cursor 链路。**与 hooks 那条并存，职责严格分开：**

| | `cursor-hook.js`（hooks） | `cursor-cli.js`（CLI） |
|---|---|---|
| 管哪种会话 | 你在 IDE 里手工开的 | 飞书发 `cursor` 发起的 |
| 会话归属 | Cursor 自己 | **本仓库**（id 由我们生成保管） |
| 回话时机 | 只有 `stop` 的瞬时窗口 | **任意时刻** |
| 有超时吗 | 有（且必须有，否则挂住 Cursor） | 无 |
| 执行中能否发指令 | 不能 | 能，自动排队 |

代码位置：`src/adapters/cursor/cli-session.js`（CLI 封装、stream-json 解析）、
`src/apps/cursor-cli.js`（会话生命周期、排队、卡片编排）、
`src/apps/cursor-cards.js` 的 `buildCliTurnCard` / `buildCliLaunchMenu`。

入口：飞书文本消息 `cursor`，或任意卡片输入框输入 `/cursor`（后者不依赖
`im.message.receive_v1` 权限，更稳，与 `/new` 同理）。

约束与踩坑点：

- **`agent` 路径要按绝对路径探测，不能只靠 PATH。** listener 常由 launchd/systemd 拉起，
  那种环境的 PATH 不含 `~/.local/bin`。`resolveAgentBin()` 逐个 `accessSync` 候选路径。
- **必须给子进程设 `CURSOR_NOTIFY_ENABLED=0`。** CLI 起的 agent 内部一样会跑本项目的
  hooks，不关掉的话同一轮既有 CLI 流式卡又有 hook 通知卡，重复发两份。
- **默认带 `--force`。** 不加它，agent 遇到需批准的命令会停下等人，而这类会话无人值守，
  等于挂死。与 `launcher.js` 启动 Claude 用 `bypassPermissions` 的姿态一致，可用
  `CURSOR_CLI_FORCE=0` 关掉。
- **`running` 标记必须落在共享 state 里，不能只放内存。** state 是多进程账本，
  内存标记在 listener 重启后就丢，会导致同一会话被并发跑两轮。
- **卡片 patch 要节流**（`PATCH_INTERVAL_MS`，默认 1500ms）。stream-json 事件很密，
  逐条 patch 会撞飞书频控。
- 会话记录用**稳定 key** `cursor_cli_<前8位>`（不带时间戳），所以卡片输入框永远路由到
  同一个会话；每次收指令时刷新 `created_at` 续命，避免长期使用的会话被过期清理掉。
- CLI 会话**不发「已收到」卡**：紧随其后就会出现一张「执行中」卡，那本身就是回执。
- 一轮往返约 10–25s（含 agent 真正干活的时间），单测请用注入的 `spawnFn`，
  不要在单测里真起进程。

### 4.x 若改用 @cursor/sdk 的代价（评估用，尚未采用）

`@cursor/sdk` 当前 1.0.28、**ESM only**（本仓库是 commonjs，需动态 `import()`）、
**`engines: node >=22.13`**（与本仓库声明的 `>=18` 冲突，会抬高 Linux 服务器部署门槛）、
需要 `CURSOR_API_KEY`、public beta 接口可能变。
就「拥有会话 + 随时推消息」这个目的而言，CLI 已能满足且代价更低（无新依赖、
不抬 Node 门槛、无需 API key），**优先考虑 CLI 而非 SDK**。

#### Cursor 卡片的特殊约束

- **实时摘要卡刻意不带输入框**：Cursor 运行中没有可回流的输入通道（唯一入口是 `stop` 的
  `followup_message`），摆一个点了没反应的输入框只会骗人。
- 完成卡分两态：`waiting=true`（有 hook 正阻塞等你）才挂输入框与「结束本轮」按钮；
  `waiting=false` 是纯通知卡，不放任何交互组件。
- 审批卡必须把「等多久、超时后会怎样」写在卡面上。
- 拿到裁决或超时后，原卡要 patch 成收敛态，撤掉所有交互组件。
- **收敛只撤交互组件，绝不能把正文一起弄丢，也不要无脑刷成灰色。**
  完成/续写卡用 `buildSettledFollowupCard`（保留助手正文，配色跟随任务本身的成败——
  任务成功就该一直是绿的）；审批卡用 `buildSettledCard`（保留「即将执行什么」的描述）。
  早期版本对两者共用 `buildSettledCard`，而它重渲染的是 `event.message`——对 `stop` 事件
  那只是「任务已完成」五个字，真正的正文是单独传进来的 `body`。结果就是：任务明明成功了，
  你在飞书回一句话之后，卡片反而变成一张灰色空卡。
  收敛版式由各调用方通过 `askFeishu({ buildSettled })` 自己决定，不要在 `askFeishu` 里写死。

### Codex

- Codex 的交互卡由 `src/apps/codex-watcher.js` 处理
- Codex 的实时摘要由 `src/apps/codex-live.js` 处理
- Codex 的真实 assistant 输出来自 `~/.codex/sessions/*.jsonl`
- `src/apps/codex-session-watcher.js` 负责把 session 中的 assistant message 与 token 信息写入 live buffer
- `bin/pty-relay.py` 只负责 PTY/输入桥接与 live capture 启动，不应继续承担“猜测 assistant 正文”的主职责

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

### 回流「已收到」反馈

- 用户在卡片上选择选项 / 给出对话回复后，`feishu-listener` 须**立即另发一张「已收到」卡**（绿色、带宿主标签、回显所选/所答），不替换原卡。
- 终端注入放**后台执行**（`this._lastInjection`），`handleCardAction` 即时返回，慢路径（多选）不阻塞反馈；注入失败仅记日志。
- 控制类操作不发「已收到」卡：中断 / Esc / 开启全局允许 / 仅展开 Other 输入框；空提交不算回复。
- 是否发卡由 `_shouldAck` 判定，卡片由 `buildReceivedCard` 构建（均在 `src/apps/feishu-listener.js`）。

#### 执行摘要卡形态（claude-live）

- **一轮一张卡**：本轮所有「文字段 + 其工具」合并进**同一张**执行摘要卡（`buildSummaryCard`），不再每段一张。同轮内新增工具/段落 → patch 同一张卡；跨轮（`turnTs` 变）才新发。
- **命令/结果点击查看**：每个工具是一张**默认折叠**的 `collapsible_panel`（`buildToolPanel`），标题只放「图标+工具+命令首行预览（截断单行）」，展开后才看完整命令（Bash 用代码块）+ 完整结果。弃用 `table`——飞书表格多行单元格会相互重叠。

#### 执行摘要并入「已收到」卡（仅 Claude）

- listener 发「已收到」卡后，把 `message_id` 写入 `received_msg_<sessionKey>`（`sessionKey` = 通知 `session_id` 去 `claude_` 前缀再 `slice(0,8)`，对齐 `claude-live` 的键），带 `created_at` 与回执文案 `detail`（`_receivedDetail` 生成，与「已收到」卡共用）。
- `claude-live` flush 时，若**新轮**且存在够新的 `received_msg_<sessionKey>`（TTL 默认 10 分钟，`FEISHU_RECEIVED_MERGE_TTL_MS` 可调），把**整张执行摘要卡 patch 进那张「已收到」卡**（合并），并消费该键（只并一次）；patch 失败则退回新发。
- 合并卡须**保留回执**（顶部 `✅ 已收到 · <detail>`、绿色、标题「已收到 · 执行摘要」），不能用普通蓝卡直接 patch 把回执覆盖没。`live_msg` 状态记 `merge`，本轮后续更新仍用合并版式。
- 终端直接发起的轮次没有该键，零影响：执行摘要照旧新发自己的卡。
- 跨进程共享 `src/session-state.json`；`received_msg_*` 与 `live_msg_*` 同形，不参与终端路由（`getLatestNotification` 无外部调用）。
- Codex 走另一套 `codex-live` 流程，不在此合并。

## 7. 测试与验证

运行全量测试：

```bash
node --test "tests/**/*.test.js"
```

**不要用 `bun test tests/` 跑全量。** bun 1.3.14 把整个目录放在同一个上下文里跑，且不等
上一个文件的异步用例收敛就加载下一个，结果是 19 个文件在自己的第一个顶层 `test()` 上直接
报 `test() inside another test() is not yet implemented in Bun`，`feishu-host-flow` 还会因
串进来的 env 把注入路由到 FIFO 而不是假 docker，217 个用例只跑到 91 个。
bun 单文件是好的（`bun test tests/apps/cursor-cards.test.js`），只有整目录不行。

### 测试目录结构

```
tests/
├── adapters/
│   ├── claude/
│   │   ├── fixture-ask.test.js        # Claude ask-handler 适配器固件
│   │   ├── fixture-hook.test.js       # Claude hook-handler 适配器固件
│   │   └── fixture-live.test.js       # Claude live-handler 适配器固件
│   ├── codex/
│   │   ├── cli-input-bridge.test.js   # Codex 输入桥接：文本/审批/单选/多选注入
│   │   └── cli-output-parser.test.js  # Codex 终端输出解析
│   └── cursor/
│       ├── control-policy.test.js     # Cursor 控制策略：开关/matcher/超时回落/输出字段
│       └── hook-adapter.test.js       # Cursor hook 事件翻译
├── apps/
│   ├── claude-ask.test.js             # Claude AskUserQuestion 按钮映射 (↓+CR)
│   ├── codex-live.test.js             # Codex 实时摘要卡片
│   ├── codex-session-watcher.test.js  # Codex session 文件监控
│   ├── codex-watcher.test.js          # Codex PTY 输出监控与交互卡
│   ├── cursor-cards.test.js           # Cursor 审批/完成/失败/实时摘要/收敛卡
│   ├── cursor-live.test.js            # Cursor 实时摘要聚合与轮次边界
│   └── feishu-listener.test.js               # 飞书监听器与交互回流
├── channels/
│   ├── codex-feishu-interaction-scenarios.test.js   # Codex 飞书交互端到端场景
│   ├── cursor-feishu-interaction-scenarios.test.js  # Cursor 远程控制端到端（含超时/发卡失败）
│   └── feishu-interaction-handler.test.js           # 飞书交互处理器单元测试
├── core/
│   ├── card-state-store.test.js       # 卡片状态存储
│   └── session-store.test.js          # 会话存储
├── fixtures/
│   └── cursor/                        # Cursor 六类 hook 事件的真实形状 payload
└── lib/
    ├── decision-bridge.test.js        # 决策交汇点：会合/超时/重复裁决/残留清理
    └── session-state.test.js          # session-state 模块测试
```

### 专项测试

- Codex 解析/桥接：`node --test tests/adapters/codex/`
- Codex 应用层：`node --test tests/apps/codex-*.test.js`
- Claude 按钮映射：`node --test tests/apps/claude-ask.test.js`
- Cursor 全链路：`node --test tests/adapters/cursor/ tests/apps/cursor-*.test.js tests/lib/decision-bridge.test.js tests/channels/cursor-feishu-interaction-scenarios.test.js`
- 飞书交互链路：`node --test tests/channels/`
- Python 语法检查：`python3 -m py_compile bin/pty-relay.py`

### 原则

- 改解析器时，先补测试再改实现
- 改交互桥时，要覆盖文本、审批、单选、多选
- 改飞书卡片时，除了单测，还应做真机弹窗验证
- Cursor 端到端测试要把 `AGENT_NOTIFIER_STATE` 与 `AGENT_NOTIFIER_DECISIONS` 指到临时目录，
  **且必须在 require 之前设置**——两者都是模块加载时按 env 定好路径的单例
- 终端注入使用 `\r`(CR) 作为 Enter，不用 `\n`(LF) — PTY raw mode 下 LF 不是 Enter
- `src/session-state.json` 是多进程共享账本：读改写必须走 `SessionState.mutate()/mutateAsync()`
  （锁内 fresh load、只改自己的键）。**严禁「load 旧快照 → await 网络 → save 整表回写」**——
  会把网络窗口期内其他进程刚 addNotification 的键清掉，飞书卡片随机变「已失效」。
  该模式曾同时存在于 claude-live flush / claude-hook Stop 去重 / codex-live / codex-watcher，
  2026-07-02 全部改为 mutate；回归测试见 `tests/lib/session-state.test.js`。

## 8. 运行与联调

Codex + 飞书联调至少需要这些进程在线：

- `node feishu-listener.js`
- `python3 bin/pty-relay.py codex ...`
- `node src/apps/codex-session-watcher.js --pts <N>` 或由 `bin/pty-relay.py` 自动拉起
- `node src/apps/codex-watcher.js`（交互卡与提示解析）

如果启动脚本提示 PID 存在但进程很快退出，优先直接前台启动排错：

- `node feishu-listener.js`
- `node src/apps/codex-watcher.js`
- `node src/apps/codex-session-watcher.js --pts <N>`

Cursor + 飞书联调只需要：

- `node feishu-listener.js`（唯一常驻进程；hook 由 Cursor 自己按需拉起）
- `~/.cursor/hooks.json` 已装好（`npm run cursor:hooks` 或 `./install.sh`）

**改了 listener 代码后必须重启它**，否则 Cursor 卡片的回调仍走旧逻辑（macOS launchd：
`launchctl kickstart -k gui/$(id -u)/com.agent-notifier.feishu-listener`）。

## 9. 真机验证脚本

- `scripts/send-codex-feishu-test-cards.js`
  - 发送 Codex 文本输入、审批、单选、多选交互卡
- `scripts/send-codex-assistant-direct.js`
  - 直接发送一张 Codex 文本卡，适合对账
- `scripts/send-codex-assistant-feed.js`
  - 通过 feed 方式发送 Codex assistant 摘要
- `npm run ask:e2e:card`
  - 发送 Claude 风格方案选择卡，适合验证 Claude 按钮注入
- `npm run cursor:e2e:cards`（或 `cursor:e2e:approval` / `cursor:e2e:followup`）
  - Cursor 全部卡片。**它走的就是生产代码路径**（`cursor-hook.askFeishu`）：真开决策请求、
    真发卡、真阻塞等你点，所以在飞书上点一下就等于验证了
    「卡片渲染 → 回调路由 → 决策回流 → 卡片收敛」整条链路，而不只是看卡片长什么样

注意：

- `send-codex-feishu-test-cards.js` 只负责交互卡，不生成 `execution_summary`
- 要验证 Codex 实时摘要，应触发真实 session 输出，或向 `/tmp/codex-live-<pts>.jsonl` 写入受控测试数据
- Cursor 真机验证前先确认 listener 在跑且**只有一个实例**，否则点击会被随机投递到别的连接
  （见 §11.4），表现为「点了没反应，最后只等到超时」

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

### 11.7 强制代理机：`NODE_USE_ENV_PROXY=1` 与 axios 会「双重代理」死锁

本机 `~/.bashrc` 注入了 `NODE_USE_ENV_PROXY=1`（Node 24 开关，让内核 `fetch`/`http(s).request`
读 env 代理）。它是**必需**的（不设则 `fetch` 直接 `fetch failed`），但和「库自己做代理」会撞车：

- **机制**：axios 自带 env 代理解析，会把请求发成 `http://star-proxy:3128` + 绝对 URL 的
  **正向代理**格式；而该开关让 Node 把「到代理的这条连接」**再套一层代理** → 代理收到自己
  发给自己的请求，**永不响应**，只能等超时。已在最底层证实：裸 `http.request` 到代理
  带开关 8s 超时、不带开关 `200 / 396ms`。
- **`no_proxy` 加代理主机名不管用**（实测无效），不要走这条路。
- **规则**：本项目所有走代理的 HTTP 客户端，一律**显式 `HttpsProxyAgent` + `proxy: false`**，
  由 agent 独家负责 CONNECT 隧道，绕开库的 env 解析 → 对该开关免疫（两种 env 下都通）。
  见 `axios-lark-client.js` 的 `buildHttp()` 与 `feishu-listener.js` 的 `buildWsHttpInstance()`。
- **第三方 SDK 要看它内部还有没有第二条 HTTP 路径**：Lark `WSClient` 的构造参数 `agent`
  **只给 WebSocket**，建连前协商网关地址（`pullConnectConfig`）用的是 SDK 自带 axios 实例，
  必须另传 `httpInstance` 才能覆盖。2026-08-13 线上故障就是漏了它 —— 卡片能发出（发卡走
  axios-lark-client，已 `proxy:false`）但**回调永远收不到**，飞书侧显示
  「目标回调服务器未在线」，日志刷 `timeout of 15000ms exceeded` + 每 300s 僵尸重建。
  自造 `httpInstance` 时必须复刻 SDK `defaultHttpInstance` 的响应拦截器（SDK 直接把
  返回值当 body 用），否则解构 `data.URL` 会炸。回归测试见
  `tests/apps/feishu-ws-proxy.test.js`。
- **排查抓手**：`timeout of 15000ms exceeded` 这个措辞是 **axios** 的，不是 ws 的 —— 见到它
  要先怀疑「某个 axios 请求走了 env 代理解析」，而不是网络不通。快速判定：
  `env -u NODE_USE_ENV_PROXY node <同样请求>` 若立刻通，就是这个坑。


