[English](./README.md) | [中文](./README.zh-CN.md)

# Agent Notifier — Feishu (Lark) Notifications for Claude / Codex CLI / Cursor

> Route all AI coding assistant interactions to Feishu. Approve, pick options, and send commands from your phone — multi-device, no terminal babysitting required.

## Why This Approach

| Pain Point | How Agent Notifier Solves It |
|------------|------------------------------|
| Claude / Codex / Cursor needs confirmations, permissions — you're chained to the terminal | Feishu interactive cards push in real time; tap once from phone, desktop, or tablet |
| You want mobile access but there's no official app | Feishu **is** your multi-platform app — iOS / Android / Mac / Windows / Web |
| Self-hosted push needs a server, domain, and DNS setup? | Feishu's long-polling mode connects directly — no public IP or domain required |
| Enterprise approval workflows are painful? | Feishu enterprise custom apps get approved in minutes; works for individuals too, completely free |
| Running tasks across multiple terminals — notifications are a mess? | Multi-terminal parallel routing keeps each terminal's interactions isolated and independent |

---

## Preview

<table>
<tr>
<td align="center" width="33%">
<img src="./docs/images/permission-confirm.jpg" width="240" /><br/>
<b>Permission Confirmation</b><br/>
<sub>Allow / Deny / Allow for Session / Allow Globally + text input<br/>Footer: project name · terminal ID (fifo) · session duration</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/permission-options.jpg" width="240" /><br/>
<b>Permission Options</b><br/>
<sub>Tool option buttons like ExitPlanMode + text input<br/>Footer: project name · terminal ID (fifo) · session duration</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/ask-user-question.jpg" width="240" /><br/>
<b>Choice Selection</b><br/>
<sub>AskUserQuestion dynamic options + Other + free-text input<br/>Footer: project name · terminal ID (fifo) · timestamp</sub>
</td>
</tr>
<tr>
<td align="center" width="33%">
<img src="./docs/images/live-execution.jpg" width="240" /><br/>
<b>Live Execution Summary</b><br/>
<sub>Tool call table · patches in place for the same task<br/>Footer: project name · timestamp</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/task-complete.jpg" width="240" /><br/>
<b>Task Complete</b><br/>
<sub>Change summary + text input for follow-up<br/>Footer: project name · session duration · token usage stats</sub>
</td>
<td align="center" width="33%">
<img src="./docs/images/task-complete-stats.jpg" width="240" /><br/>
<b>Completion Notification (with Stats)</b><br/>
<sub>Test results table + text input for follow-up<br/>Footer: project name · session duration · token usage stats</sub>
</td>
</tr>
</table>

---

## Card Types

| Scenario | Card Color | Description |
|----------|------------|-------------|
| Permission confirmation | 🟠 Orange | Allow / Allow for session / Deny + text input |
| AskUserQuestion single-select | 🟠 Orange | Dynamic option buttons + Other + text input |
| AskUserQuestion multi-part | 🟠 Orange | Q1 → Q2 → Q3 sent one card at a time |
| Task complete | 🟢 Green | Summary, duration, tokens + text input |
| Abnormal exit | 🔴 Red | Error details + text input |
| Live execution summary | 🔵 Blue | Patches the same card in place for the current task |
| Cursor approval | 🟠 Orange | Allow / Deny / Hand back to IDE + deny-reason input |
| Cursor complete | 🟢 Green | Summary + text input (replying makes Cursor continue) |
| Cursor live summary | 🟣 Indigo | Collapsible tool panels, patched in place per turn |

---

## Feature Overview

**Notifications** — Feishu interactive cards / task completion & failure alerts / live execution summaries / session duration & token stats / local audio alerts

**Interactions** — Button clicks and text input flow back to the agent / multi-terminal parallel routing / one shared Feishu entry point for Claude, Codex, and Cursor

---

## How the Three Hosts Differ

"Remote control" works through **two fundamentally different mechanisms**, which determines
what can go wrong:

| | Claude | Codex CLI | Cursor |
|---|---|---|---|
| Event source | Claude hooks | PTY output + session files | Cursor hooks |
| Answer channel | Injects keystrokes into the terminal | Injects keystrokes into the terminal | **Hook returns the verdict directly** |
| Needs a shell wrapper | Yes (`claude()`) | Yes (`codex()`) | **No** |
| Needs pty-relay | Yes (outside tmux) | Yes (outside tmux) | **No** |
| Scope | Claude Code in a terminal | Codex CLI in a terminal | Cursor IDE and CLI |

**Why Cursor is different:** Cursor hooks are **blocking** processes — Cursor writes the event
JSON to the hook's stdin and then *waits* for the hook to print a JSON verdict on stdout. So
"approve a command remotely" becomes "let the hook process wait for your tap in Feishu, then
return `permission` to Cursor." No guessing which terminal to target, and none of the dropped
keystrokes or scrambled arrow keys that come with injection.

The tradeoff is that we must guarantee Cursor is **never left hanging**: every wait here has a
timeout, and on timeout it falls back to Cursor's own confirmation dialog.

### Cursor has two pipelines, split by who owns the conversation

Hooks are only a side-channel observer; they can't reach a conversation that already exists in
the IDE (the sole entry point for injecting a user message is `stop`'s `followup_message`, which
exists for one instant). So to reply **at any time** the way you can with Claude, the
conversation has to be owned by this repo:

| | Conversation opened in the IDE | Conversation launched from Feishu |
|---|---|---|
| Pipeline | hooks (`cursor-hook.js`) | cursor-agent CLI (`cursor-cli.js`) |
| Notification cards | ✅ completion / live summary | ✅ one card per turn, patched as it streams |
| Remote approval | ✅ blocks waiting for your tap | auto-allowed (unattended by design) |
| **Reply anytime** | ❌ only at the instant a turn ends | ✅ **any time**, no timeout |
| Send while running | ❌ | ✅ queued, runs after the current turn |

Both pipelines work side by side once installed.

#### Why the IDE's multiple-choice questions need special handling

The IDE's interactive question widget (`AskQuestion`) is a blind spot: it fires **no hook** and
does **not end the turn**, so no completion card is sent. From your phone you can neither see the
question nor answer it — the conversation just sits there. None of Cursor's 18 agent events means
"the agent is waiting on the user", so there is nothing to react to after the fact.

So this repo **routes around it** by injecting a convention into the agent's context: when you
need to decide something, call `ask_user` (the MCP tool that sends a Feishu card and blocks for
your tap); if that tool is unavailable, number the options in plain prose and end the turn. The
question then lands on the completion card, whose input box already works remotely. Toggle with
`CURSOR_STEER_QUESTIONS` (on by default).

The injection uses **two** entry points, because those are the only agent events that support
`additional_context`:

- `sessionStart` — full text, once per newly created conversation.
- `postToolUse` — a condensed reminder, repeated at most once per
  `CURSOR_STEER_REARM_SEC` (30 minutes by default) per conversation. **This one is what covers
  already-open conversations**: `sessionStart` fires only when a conversation is created, and
  neither reloading the window nor Cursor upgrading itself triggers it again (measured: 12 `stop`
  events and zero `sessionStart` on one conversation). Even a shot that did land gets dropped by
  context compaction, which is why long-lived conversations drift back to the widget.

Both `hooks.json` and `mcp.json` are hot-reloaded, so edits take effect immediately with **no
window reload**. One important difference: hooks are spawned fresh on every event and therefore
always run the latest code, while an MCP server is a long-lived process that **does not restart
when you only change its code** — touch its entry in `mcp.json` to cycle it after an upgrade.

`ask_user`'s waiting window has one more trap worth knowing: Cursor's MCP client kills a tool
call after **120 seconds of silence on the connection** (`MCP error -32001`), no matter how large
a total window you configure. So while waiting, the server emits a `notifications/progress`
heartbeat every `CURSOR_ASK_HEARTBEAT_SEC` (20 seconds by default) to reset that idle timer. A
separate 60-minute per-call ceiling still applies, which is what `ask_user_wait` chunking is for.
The total window, `CURSOR_ASK_TIMEOUT_SEC`, defaults to 24 hours, matching the completion card's
follow-up window.

Steering is a soft constraint, not an interception — the model may still use the widget, and
Cursor offers no way to veto it. When that happens the `cursor-stall-watch` watchdog sends a
"probably waiting on you" alert after 15 minutes of silence (`CURSOR_STALL_ALERT_SEC`) telling
you to go back to the IDE. That card deliberately has no input box — no hook is waiting at that
point, so an input box would be a lie.

#### Sessions connected to a server over Remote-SSH

**With Cursor Remote-SSH the whole agent runtime — hooks included — runs on the remote machine.**
Your local `~/.cursor/hooks.json` does not apply to those windows, so by default they send no
Feishu cards at all. To make them notify, install this repo and its hook on the remote machine,
with `FEISHU_APP_ID` / `FEISHU_APP_SECRET` set in the remote `.env` (the remote hook sends cards
itself):

```bash
# on the remote machine (read-only events only)
npm run cursor:hooks:notify-only
```

Always use `--notify-only` there: approval and follow-up are blocking pipelines that require the
card-sending hook and the callback-receiving listener to share one decision file, and the listener
is local while the hook is remote. **Do not start a second listener on the remote either** — Feishu
distributes callbacks randomly across long connections for the same app, so an extra listener
silently swallows some of your taps (see "Sharing one Feishu app across machines").

Set `AGENT_NOTIFIER_MACHINE=<ssh host alias>` in the remote `.env` so cards are stamped `📍 GY_2`;
otherwise you can't tell which machine a card came from.

---

## Quick Start

### 1. Clone the Repository

```bash
git clone <repo-url>
cd agent_notifier
```

### 2. Configure the Feishu App

Edit `.env` (automatically created from `.env.example` on first install):

```bash
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here
# FEISHU_CHAT_ID=
```

> For step-by-step instructions on creating and approving a Feishu custom app, see [Feishu Setup Guide](#feishu-setup-guide) below.

### 3. Install

```bash
bash install.sh
```

The install script handles everything automatically:
- Checks dependencies (Node.js, npm, python3)
- **Cleans up previous configuration** (runs `uninstall.sh` internally)
- Installs Node.js dependencies
- Creates `.env` from `.env.example` (if it doesn't exist)
- Writes Claude Code hooks to `~/.claude/settings.json`
- Writes Cursor hooks to `~/.cursor/hooks.json` (only touches its own entries; yours are preserved)
- Injects `claude` / `codex` shell wrapper functions
- **Starts the Feishu listener and registers it for auto-start on boot**

> Running `install.sh` multiple times is safe — it cleans up before reinstalling each time.

### 4. Reload Your Shell

```bash
source ~/.zshrc
# or source ~/.bashrc
```

### 5. Start Using It

```bash
claude
# or
codex
```

Cursor needs no wrapper function and no new terminal — once the hooks are installed, just use
Cursor. Completion and live-summary cards flow to Feishu automatically (a failed tool shows up
as a step inside the live summary, not as a card of its own).

### 6. (Optional) Enable Cursor Remote Control

Notifications work out of the box. **Control features are off by default** because they really
do block Cursor while waiting for you — if you're sitting at your desk, Cursor would appear to
hang (`beforeShellExecution` fires for *every* command, including ones that would have been
auto-approved, like `ls`).

To enable remote control, edit `.env`:

```bash
# Approve / deny Shell and MCP calls from Feishu
CURSOR_REMOTE_APPROVAL=1
# Strongly recommended: only ask about dangerous commands, or you'll tap for every single one
CURSOR_APPROVAL_MATCHER=rm\s+-rf|git push|npm publish|kubectl|terraform

# After a task ends, send the next instruction from Feishu and Cursor continues automatically
CURSOR_REMOTE_FOLLOWUP=1
```

Then re-run `bash install.sh` — the `timeout` values in `hooks.json` must track your timeout
settings, otherwise Cursor kills the hook before you've had a chance to answer.

---

## Uninstall

```bash
bash uninstall.sh
```

The uninstall script cleans up:
- Stops and removes the Feishu listener service (launchd / systemd / crontab)
- Terminates background processes (feishu-listener, codex-watcher, codex-session-watcher, pty-relay)
- Removes hooks from `~/.claude/settings.json`
- Removes this project's hooks from `~/.cursor/hooks.json` (leaves your own entries alone)
- Removes shell function injections from `~/.zshenv` / `~/.zshrc` / `~/.bashrc` / `~/.bash_profile` / `~/.profile`
- Cleans up runtime files (session-state, pid, log, /tmp buffers, decision directory)

> `.env` and `node_modules/` are preserved. Delete them manually if you want a full cleanup.

---

## Cross-Platform Support

The full stack runs identically on macOS and Linux, and can be deployed standalone on a Linux server:

```bash
git clone <repo-url> && cd agent_notifier
cp .env.example .env && $EDITOR .env   # set FEISHU_APP_ID / FEISHU_APP_SECRET
bash install.sh                        # one-shot install (incl. statusLine, claude-remote-shell)
claude
```

### Three components

| Component | Role | Install |
|-----------|------|---------|
| **agent-notifier** | Feishu interactive cards + remote input injection (this repo) | `install.sh`, fully automatic |
| **ccusage statusline** | Status-bar cost/duration + `cost-capture.js` feeding official metrics to completion cards | `install.sh` wires up cross-platform `scripts/statusline.sh` |
| **claude-remote-shell** | Redirects Claude's Bash tool commands to a remote host over SSH (optional) | `install.sh` fetches the script; mutagen installed separately |

They are layer-separated and do not conflict: claude-remote-shell only redirects Bash tool commands, while TUI / hooks / statusLine all run locally.

### Dependencies

| Dependency | Required | Purpose | Install (Linux / macOS) |
|------------|----------|---------|------------------------|
| node ≥18, npm | yes | runtime | `apt install nodejs npm` / `brew install node` |
| python3 | yes | pty-relay | built-in / `brew install python3` |
| jq | enhanced | statusLine timestamp parsing | `apt install jq` / `brew install jq` |
| bun or npx | enhanced | run ccusage | `curl -fsSL https://bun.sh/install \| bash` |
| mutagen | enhanced | claude-remote-shell sync | [releases](https://github.com/mutagen-io/mutagen/releases) / `brew install mutagen-io/mutagen/mutagen` |

> Missing enhanced dependencies only trigger a warning with the install command — they do not abort installation.

| Platform | Service Management | Auto-Start on Boot |
|----------|-------------------|--------------------|
| macOS | launchd (`~/Library/LaunchAgents/`) | `RunAtLoad` + `KeepAlive` |
| Linux (with systemd user session) | systemd user service | `systemctl --user enable` |
| Linux (no systemd, e.g. pure SSH) | nohup + crontab `@reboot` | crontab fallback |

> Shell functions: zsh → `~/.zshenv`; bash → login file (`~/.bash_profile` or `~/.profile`) **and** `~/.bashrc`. Injecting only `.bashrc` is not enough — many distros' default `.bashrc` returns early for non-interactive shells, so the wrapper must go directly into the login file. This ensures non-interactive login shells (e.g. `claude-remote-shell` startup via `bash -l -c`) also load the PTY relay wrappers.

### Service Management Commands

**macOS:**
```bash
# Check status
launchctl print gui/$(id -u)/com.agent-notifier.feishu-listener
# Stop
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.agent-notifier.feishu-listener.plist
# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-notifier.feishu-listener.plist
```

**Linux (systemd):**
```bash
systemctl --user status agent-notifier-feishu
systemctl --user restart agent-notifier-feishu
journalctl --user -u agent-notifier-feishu -f
```

---

## Configuration

### `.env` Example

```bash
# Feishu custom app
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here
# FEISHU_CHAT_ID=

# Default host (optional)
# DEFAULT_AGENT_HOST=claude
# CODEX_BIN=codex

# Explicitly specify tmux pane (optional)
# CLAUDE_TMUX_TARGET=claude:0.0

# Live summary (optional, shared by all three hosts)
# FEISHU_LIVE_CAPTURE=1
# FEISHU_LIVE_DEBOUNCE_MS=3000

# Cursor remote control (off by default — see table below)
# CURSOR_REMOTE_APPROVAL=1
# CURSOR_APPROVAL_MATCHER=rm\s+-rf|git push|npm publish
# CURSOR_REMOTE_FOLLOWUP=1

NOTIFICATION_ENABLED=true
# NOTIFICATION_EXPIRE_HOURS=12
# ENABLE_ESC_BUTTON=true
SOUND_ENABLED=true
```

See `.env.example` for the full list — every entry documents why it defaults the way it does.

### `FEISHU_LIVE_CAPTURE` Options

Accepted values:
- `1` / `true`: Enable all capture modes
- `tools`: Tool / command summaries
- `output`: Assistant output content
- `results`: Tool execution result summaries
- Combine as needed: `tools,output,results`

All three hosts share these semantics. Codex output comes from `~/.codex/sessions/*.jsonl`;
Cursor output comes straight from the hook payload (`postToolUse` carries `tool_input` and
`tool_output`). Neither is inferred from terminal text.

Cursor treats `output` with one exception: the agent's own words appear **only on the completion
card**, never duplicated into the summary card. Cursor's `afterAgentResponse` fires once per turn,
at the very end, so whatever the summary card showed there was always identical to the completion
card that arrived moments later — the same paragraph, read twice. Only with `CURSOR_NOTIFY_STOP`
off (no completion card at all) does the summary card carry it, in a `❯ Cursor` panel that is
always expanded regardless of length. Tool steps are always collapsed.

> **On a machine where several people share one OS account, set `CURSOR_NOTIFY_ROOTS` first.**
> Both `~/.cursor/hooks.json` and `~/.cursor/mcp.json` are user-level, so a colleague's Cursor
> session triggers this repo too: their cards land in your Feishu chat, and the injected
> question-steering makes *their* agent call `ask_user` — which blocks their session on your
> phone for up to 24 hours while all they see is a stalled agent. Measured on one shared box:
> 4 of the 5 running MCP server processes belonged to someone else's windows.

Every Cursor card carries a **conversation name** as its subtitle (same shape as the Claude
cards) so you can tell parallel conversations apart. Cursor's hook payload has no title field,
so the name is taken from the first user message in `transcript_path` — the same thing Cursor
titles a chat from. If it can't be resolved, the subtitle is simply omitted.

**Images in the agent's text**: an `![caption](/path/to/x.png)` gets uploaded to Feishu so you
can actually see it on your phone (needs the `im:resource:upload` scope). When it can't be
uploaded it degrades to a one-line `🖼 caption + path` reference stating why (missing file, over
10 MB, missing scope). This is not cosmetic: Feishu parses `![]()` as image syntax and the
parenthesised value must be one of its own image keys, so leaving a local path in there gets the
**entire card rejected** — the failure we hit looked like "summary card arrived, completion card
never did", and the completion card is the only way to keep the conversation going remotely. At
most 5 images per card (the hook is blocking; nobody should wait on a screenful of uploads), and
relative paths resolve against the workspace root.

A failed tool (`postToolUseFailure`) is just another step in the same summary card — its title
carries `❌` plus the failure reason, the error message takes the place of the output, and the
card header gets a red counter. It stays collapsed like every other step; error text is long
enough that auto-expanding it would just bloat the card. There is no separate failure card: one
red card per failed tool was noise, and dropping the event entirely would have made failed
steps vanish from the summary.

### Cursor-Specific Settings

| Variable | Default | Purpose |
|----------|---------|---------|
| `CURSOR_NOTIFY_ENABLED` | `1` | Master switch; off means no Cursor cards at all |
| `CURSOR_NOTIFY_STOP` | `1` | Send a completion card when a task ends |
| `CURSOR_NOTIFY_ROOTS` | empty | **Required on shared machines**: only serve these workspace path prefixes (comma-separated); empty = no filtering |
| `CURSOR_NOTIFY_USERS` | empty | Only serve these Cursor accounts (`user_email`); second line of defence |
| `CURSOR_REMOTE_APPROVAL` | `0` | **Remote approval**: approve/deny Shell and MCP calls from Feishu |
| `CURSOR_APPROVAL_TIMEOUT_SEC` | `180` | Approval wait cap; on timeout falls back to Cursor's own dialog |
| `CURSOR_APPROVAL_MATCHER` | empty | JS regex; only ask about matching commands (empty = ask about all, noisy) |
| `CURSOR_APPROVAL_MCP_MATCHER` | empty | Only ask about matching `<server>.<tool>` |
| `CURSOR_APPROVE_TOOLS` | empty | Tool allowlist for the `preToolUse` gate (hook must be added manually) |
| `CURSOR_REMOTE_FOLLOWUP` | `0` | **Remote follow-up**: send the next instruction from Feishu when a task ends |
| `CURSOR_FOLLOWUP_TIMEOUT_SEC` | `300` | Follow-up wait cap; on timeout the turn just ends (hour-scale values supported, see below) |
| `CURSOR_FOLLOWUP_STATUSES` | `completed` | Which end states are worth waiting on |
| `CURSOR_STOP_LOOP_LIMIT` | `50` | Max automatic follow-up turns per conversation |

> ⚠️ After changing any `CURSOR_*_TIMEOUT_SEC`, re-run `install.sh` (or `npm run cursor:hooks`).
> The `timeout` in `hooks.json` must exceed our own wait cap, or Cursor kills the hook early and
> all you see is "I tapped and nothing happened."

#### Replying much later (hour-scale waits)

Hour-scale follow-up waits are supported — for example 12 hours:

```bash
CURSOR_REMOTE_FOLLOWUP=1
CURSOR_FOLLOWUP_TIMEOUT_SEC=43200   # 12h
NOTIFICATION_EXPIRE_HOURS=24        # must exceed the wait, or the card expires first
```

Then run `npm run cursor:hooks` — it syncs the `hooks.json` timeout and warns if
`NOTIFICATION_EXPIRE_HOURS` is set too low.

Three pitfalls on this path are already handled, but worth knowing about:

- Each decision request records its own deadline, so the listener's age-based cleanup won't
  delete a request that still has a waiter
- The waiter is liveness-checked (pid + hostname): if you close Cursor and then tap the card,
  you get an explicit "this tap had no effect" instead of a false success
- Polling backs off from 120ms to 1s after the first 30 seconds, so a 12-hour wait doesn't burn
  millions of pointless syscalls

**The cost:** the conversation stays parked for the whole wait, so the IDE looks like it's still
working. If you're at your desk and want to wrap up immediately, tap "结束本轮" (End turn) on the card.

> If what you actually want is to be free of this one-instant window entirely, use the
> Feishu-launched sessions below — those have no timeout and the input box is always live.

### Cursor CLI sessions: genuine reply-anytime

Install and log in to the CLI once (browser login, **no API key needed**):

```bash
curl https://cursor.com/install -fsS | bash
~/.local/bin/agent login
```

Then send `cursor` in Feishu (or type `/cursor` into any card's input box), pick a project, and
you get a Cursor session **owned by this repo**:

- One card per turn, patched live while it streams, finalized as a green completion card
- The input box is **always live** — reply whenever and it continues, with no timeout
- Instructions sent mid-run are **queued** (the card shows the queue depth) and fire automatically
- Footer carries the model and token usage

Configuration (all optional, see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `CURSOR_AGENT_BIN` | auto-detected | Path to `agent`. When the listener is started by launchd its PATH excludes `~/.local/bin`, so absolute paths are probed |
| `CURSOR_CLI_MODEL` | account default | Pin a model |
| `CURSOR_CLI_FORCE` | `1` | Auto-allow tool calls. Setting it to 0 makes the agent stop and wait for approval, which deadlocks an unattended session |
| `CLAUDE_LAUNCH_DIR` | `~/coderepo` | Root directory for the project list (shared with Claude) |

**What this pipeline does not solve:** it can't reach conversations you opened in the IDE (those
still go through the hooks pipeline above). Also, Feishu-launched sessions are headless, so the
agent has nobody to ask — you won't get multiple-choice cards, but you also won't get stuck.

---

## Feishu Setup Guide

### 1. Create a Custom App
Log in to the [Feishu Open Platform](https://open.feishu.cn) and create an enterprise custom app.

### 2. Get App ID / App Secret
Copy the credentials from the app dashboard and add them to `.env`.

### 3. Enable Bot Capability
Turn on the Bot feature under App Capabilities.

### 4. Set Event Subscription to Long Polling
No public IP or domain needed.

### 5. Add Events
- `card.action.trigger`

### 6. Request Permissions
- `im:message`
- `im:message:send_as_bot`
- `im:chat:readonly`
- `im:resource:upload` (optional) — lets local images in the agent's own text get uploaded to
  Feishu so you actually see them on your phone. Without it everything still works: each image
  degrades to a one-line `🖼 caption + path` reference and the card is delivered as usual.

### 7. Publish the App
After publishing, add the bot to your target group chat.

---

## Common Commands

### Install / Uninstall

```bash
bash install.sh      # Install (auto-cleans old config → reinstalls)
bash uninstall.sh    # Uninstall (stops services → cleans up config)
```

### Feishu Listener (Manual)

```bash
npm run feishu-listener         # Run in foreground
npm run feishu-listener:start   # Start in background with nohup
npm run feishu-listener:stop    # Stop background process
```

### Codex Commands

```bash
npm run codex-watcher
npm run codex-watcher:start
npm run codex-watcher:stop
```

### Cursor Commands

```bash
npm run cursor:hooks           # Idempotently write ~/.cursor/hooks.json
npm run cursor:hooks:remove    # Remove only this project's entries
npm run cursor:e2e:cards       # Real-device check: sends every card and really blocks on your tap
npm run cursor:e2e:approval    # Approval path only
npm run cursor:e2e:followup    # Follow-up path only
```

Cursor needs only one long-running process (`feishu-listener`); Cursor spawns the hooks itself.

---

## Architecture Overview

### Claude Pipeline
- Claude Hooks fire events → `src/apps/claude-hook.js` builds cards → Feishu listener receives callbacks → input injected back into the local terminal

### Codex Pipeline
- `pty-relay.py` establishes a terminal bridge → `src/apps/codex-watcher.js` handles interactive cards → `src/apps/codex-session-watcher.js` reads session files → `src/apps/codex-live.js` handles live summary cards

### Cursor Pipeline

Cursor uses a blocking hook plus a decision rendezvous — it never touches a terminal:

```
Cursor ──event JSON──▶ cursor-hook-handler.js
                          │
                          ├─ sends the Feishu card (approval / completion)
                          ├─ registers a pending decision in /tmp/agent-notifier-decisions
                          └─ blocks, waiting…
                                       ▲
You tap in Feishu ──▶ feishu-listener ─┘ writes the verdict
                          │
Cursor ◀──stdout JSON─────┘  permission: allow/deny/ask
                             followup_message: "now do this next"
```

- Event translation: `src/adapters/cursor/hook-adapter.js`
- Control policy (switches, matchers, timeout fallback): `src/adapters/cursor/control-policy.js`
- Cards: `src/apps/cursor-cards.js`; main flow: `src/apps/cursor-hook.js`
- Live summaries: `src/apps/cursor-live.js` (turn boundary from `generation_id`; same turn patches the same card)
- Rendezvous: `src/lib/decision-bridge.js` — pinned to `/tmp` because macOS allocates `TMPDIR`
  per session, so the IDE-spawned hook and the launchd-spawned listener would otherwise land in
  different directories

### Terminal Injection Methods (Claude / Codex only)

To route Feishu input back to Claude / Codex, the project supports several injection methods:

| Method | Use Case |
|--------|----------|
| tmux | Recommended — run `claude` / `codex` inside a tmux session |
| PTY relay | Non-tmux environments; `pty-relay.py` sets up a FIFO injection channel automatically |
| Explicit tmux pane | `CLAUDE_TMUX_TARGET=claude:0.0` |

Injection priority: `CLAUDE_TMUX_TARGET` > auto-detected tmux pane > FIFO relay > pty master direct write > TIOCSTI fallback

### Hook Configuration

Handled automatically by `install.sh`.

**Claude** goes into `~/.claude/settings.json`:

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

**Cursor** goes into `~/.cursor/hooks.json` (the `timeout` values are derived from your `.env`
timeouts and must exceed our own wait caps):

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

`preToolUse` (per-tool gating) and `subagentStop` (subagent follow-up) are implemented but not
registered by default — they fire for every tool call and every subagent, which is too noisy.
Add them to the config above if you want them.

---

## Testing & Debugging

```bash
# Run tests
bun test tests/
python3 -m py_compile pty-relay.py

# Send test cards
node scripts/send-codex-feishu-test-cards.js --pts /dev/pts/<N>
npm run ask:e2e:card
npm run cursor:e2e:cards       # Cursor: really blocks on your tap, so one tap verifies the whole chain
```

Recommended manual checks:
- Claude completion card sends correctly
- Codex text input / approval / single-select / multi-select all flow back to the terminal
- Codex live cards patch in place for the same task and create new cards for new tasks
- Tapping Allow/Deny on a Cursor approval card actually lets the command through or blocks it, and the original card collapses to "handled"
- Replying on a Cursor completion card makes Cursor start another turn
- Long text is properly chunked

Cursor-specific check (mandatory after touching `cursor-hook.js`):

```bash
# stdout is the verdict channel Cursor reads — it must contain only clean JSON
node cursor-hook-handler.js < tests/fixtures/cursor/stop.json 2>/dev/null | od -c
# Expected: {  }  \n  — one extra byte and Cursor treats the whole output as invalid JSON
```

---

## Notes

- In PTY raw mode, Enter sends `\r` (CR), not `\n` (LF) — applies to the Claude / Codex injection path
- Completion cards include a text input field for easy follow-up conversation
- `im.message.patch` strips input fields, so completion cards are always sent as new messages while in-progress cards use patch
- Cursor live summary cards **deliberately omit the input box** — a running Cursor has no channel
  to receive outside text (the only entry point is the completion card at the end of a turn), so
  an input box that does nothing would just mislead you
- Every Cursor wait has a timeout fallback; Cursor is never left hanging
- Only **one** listener may be online per Feishu app; extras cause callbacks to be randomly
  routed, which shows up as sporadic "card expired" warnings
- Keep sensitive config in `.env` — do not commit it

---

## Contributing

If you're looking to contribute or extend the project, start with:
- `docs/ai_rules.md`
- `docs/ai_docs/README.md`
- `src/apps/claude-hook.js`
- `src/apps/codex-live.js`
- `src/apps/codex-watcher.js`
- `src/apps/cursor-hook.js` + `src/lib/decision-bridge.js` (core of Cursor's blocking control)
- `src/channels/feishu/feishu-interaction-handler.js`

---

## License

[MIT](./LICENSE)
