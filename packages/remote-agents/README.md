# DSH Remote Agents

**English** | [简体中文](README.zh-CN.md)

Use remote Claude Code, Codex, DSH, Grok, CodeBuddy and Antigravity directly in DSH's ordinary model picker and main conversation. DSH connects to each CLI's native protocol over system OpenSSH. **No Paseo daemon, SDK or remote service is required.**

Remote Claude main chat has a default-off native DSH goal bridge, enabled per session with `claudeGoalSessions` (opted-in turns restart the CLI and end in-process background tasks): [Claude goal guide](docs/claude-goal.md). This is the narrow exception to excluding local tool schemas; it does not forward the local system prompt.

## Main conversation

Each CLI appears as a separate provider in DSH's ordinary model picker:

1. Open **Settings → Remote agents** and add an SSH host and select the CLIs you want to enable. Saving discovers only their models; you can also save a machine first and choose its CLIs later. **No project name or project path is required.**
2. Select a remote workspace in DSH (see [Remote workspaces](#remote-workspaces)), then choose a model labelled with its host under **Claude**, **Codex** or another CLI provider. The native picker and `/model` only show models belonging to that workspace’s machine. In a folder on this computer they show this computer's own CLIs (see [This computer](#this-computer)); missing or unverified workspaces hide remote models. Because the workspace already identifies the machine, the composer button and the menu’s **Model** row show only the model name, such as **Opus 5.5**; the model list shows the host in muted text after each name, and the button’s tooltip shows the full name.
3. Send messages in the normal composer. Conversations execute in **the current workspace’s verified remote directory**, translating dsh-remote mirrors and Claude SSH placeholders. Every send and follow-up checks machine and directory placement again, so an old model selection cannot send to another machine after a workspace switch. Missing remote directories fail explicitly.

Change the CLI checkboxes on a machine card and click **Apply selection**. Disabled CLIs are neither probed nor shown in the model picker; existing agents keep running. New machines start with no CLIs selected, while older saved machines retain their existing provider scope.

The native model-label contribution coexists with other plugins' label renderers. Custom Codex-style composer pickers also omit the host from captions that match a saved remote model catalog, while retaining their full tooltip, reasoning effort and selection controls. Model catalogs and saved selections keep their original names and IDs.

**Collapsible model groups** are a separate plugin, `dsh-model-groups`, since 0.2.57. Install it to fold provider headings in the model menu; choices saved by earlier versions carry over.

Model catalogs are saved per machine on the DSH server and shared between clients. The same model entry works across workspaces on that machine without per-project duplicates. The picker reads cached models and filters by the workspace’s SSH host, user and port; process-routed workspaces verify the actual machine identity. While conversations work on a machine, its saved models are checked again in the background once they are an hour old, so a CLI's new models show up by themselves; a background check keeps a CLI's models when the machine or that CLI fails just then. Use **Refresh models** beside the machine to see a change at once, such as after CLI/account changes, or to discover an existing host after upgrading. Discovery uses the remote account's home directory; execution uses the conversation's workspace directory, and project-specific model availability is validated at startup.

- Each DSH conversation and selected machine / CLI has an independent native CLI session, with its working directory bound on the first message. Follow-ups reuse it, including after a DSH restart when that CLI supports resume. Switching models within a CLI resumes that same session; a non-resumable CLI asks you to start a new conversation. Previously separate model sessions remain accessible. Switching machines or CLIs supplies available conversation text as context; DSH's local system prompt, injected workspace instructions and local tool schemas are excluded.
- Replies and thinking stream into the main conversation. Remote tool calls appear as native DSH tool cards when the response ends; they execute on the remote machine. They are recorded as completed external work, so DSH never executes them again. In a Claude conversation, the short progress sentences Claude writes between tools appear in the reply, and while a tool runs the reply ends with a line naming it, which is never saved. Delegated subagents and team members keep those sentences folded, because their reply is their result. Approvals and questions use DSH's native prompts.
- The DSH thinking selector uses the CLI's discovered reasoning levels. Claude and Codex follow the conversation's DSH permission (the composer or `/permission`): **Read Only** runs Claude in `default` (ask before tools) and Codex in read-only, **Workspace Write** runs Claude in **Accept edits** and Codex in workspace-write, **Full access** runs both without approval prompts, and **Auto review** runs Claude in **Auto** and Codex in workspace-write. A change applies from the next message and overrides a mode chosen in Open sessions. A custom DSH permission keeps the session's current mode; a new conversation with one uses the remote CLI's own settings. **Stop** or cancelling the response interrupts the remote CLI turn. Quitting DSH or reloading the plugin does not; see [Persistence and recovery](#persistence-and-recovery).
- Antigravity follows the DSH permission too: **Read Only** runs it in **Default** (ask before edits and commands), **Workspace Write** in **Accept edits**, and **Full access** and **Auto review** in **Auto**. Under **Full access**, whatever a remote CLI still asks is allowed once without a prompt, as DSH's own tools are; this includes Antigravity's Auto, which asks before irreversible actions, and Grok, CodeBuddy and DSH, which keep their own modes. Claude Code safety checks and plans are not allowed this way; with nobody asked they are refused. When DSH refuses a CLI's request without showing it, because the conversation's permission never asks, the reply says which request was not run.
- **Codex Fast:** When the conversation's Codex model offers a faster service tier, a lightning button appears in the composer toolbar, after the permission control. Turn it on and the conversation's next messages use Fast; turn it off to return to the remote Codex configuration, including a `service_tier` set there. The switch is saved per conversation and keeps the same Codex thread. Fast uses more of the remote account's quota. Each model has one picker entry; a conversation still on an old **Fast** entry moves to the model's entry with the lightning on.
- **Agent teamwork:** DSH's **Enable agent teamwork** switch in the model menu is hidden while a remote CLI model is selected. That mode gives task-board tools and a team prompt to DSH's own models only; a remote CLI receives neither. The switch comes back with a DSH model, and the conversation's saved choice is kept.
- **Usage ring:** a ring before the send button shows how full the remote session's context window is. Hover over it, or click it, to see the remote account's plan limits for Claude, Codex and Antigravity, such as the session and weekly windows (Antigravity: one pair for the Gemini models, one for the Claude and GPT models). These come from the CLI on the SSH host, so credentials never leave it; Antigravity's from `agy -p /usage` (CLI 1.1.11 or later), which calls no model. Limits are read when the panel opens, cached for five minutes and read again after a turn finishes; use the refresh button to check now.
- **Prompt cache:** the same panel shows input/output tokens, cache reads/writes and the fraction of input tokens served from cache for the latest reported Claude or Codex model request. The section starts folded to its hit rate; click it to show the breakdown, and it stays open for later visits. This is per model request, so a tool loop may update it several times in one turn. Codex also offers an expandable thread total. Counts are saved with the session and remain available after detach or restart. Unreported fields show **Unknown**; a reported zero stays **0**. Cached tokens still occupy the context window. These are CLI-reported token counts, not a billing estimate.
- Lost responses can replay the saved output by message identity without sending the task again. Unconfirmed delivery or an unfinished response after disconnection is reported explicitly. Send a new message to continue the saved session.
- **Turns Claude runs by itself.** Claude Code goes on without a new message when a background task it ran finishes, such as a command or subagent it left running in the background, or at a wake-up it scheduled. The conversation shows such a turn as it runs, headed **Claude continued on its own** in the language of the conversation, with the notice Claude got; the session reads as running meanwhile, and Stop stops the turn. A message sent while that turn runs waits for it to end, as typing in Claude's terminal would; if you press Stop while it waits, it is not sent. **Open sessions** shows the turn with the same notice.
- **When Claude changes model by itself.** When Claude's safeguards refuse a request, Claude Code retries it on another model and later turns in the session stay there, while the model picker does not change. The reply and **Open sessions** say where it happened and which model took over. To use another model, pick a different one; it applies to your next message. To return to the original model, send a message on another model first, then pick it again.
- Main chat accepts **text, uploaded images and files**. Claude and Codex receive images through their native protocols; ACP CLIs expose image input only when their initialization reports support. Files are streamed over SSH into the verified remote workspace and supplied as read-only paths for the CLI’s file tools. Only attachments from the conversation are transferred. The CLI uses its own credentials, tools, instructions and context management. DSH summarization runs in a disposable CLI session, separate from the coding conversation.

## Remote workspaces

Use DSH's **Add workspace** to work on a directory of a saved machine. With machines saved, it opens a dialog: **This computer** uses the system folder picker as before, **Remote machine** browses the selected machine's directories over SSH, and **From a project** starts a new workspace from one of your Git projects (see [New workspaces from a project](#new-workspaces-from-a-project)). Choose a folder and **Use this folder** to add it; the remote models of that machine are then available in its conversations. Without saved machines or Git projects, **Add workspace** opens the system folder picker directly.

- The dialog remembers the last tab and each machine's last folder. Paths may start with `~/`. Hidden folders are listed after **Show hidden folders**.
- Files stay on the remote machine. DSH records the workspace as a local anchor under `$DSH_HOME/remote-workspaces/`, in the same format as the dsh-remote plugin. Use the **Remote workspace** panel for live files and select **Remote workspace** in the native terminal's shell menu for an interactive SSH terminal. In a remote conversation, **New terminal** opens it directly: while the conversation is in view the plugin makes it DSH's remembered shell, and leaving gives back the shell you used before. Chosen in a local conversation, it opens your local shell, though the tab is still titled **Remote workspace**. The default local Files view and local shells still refer to the anchor.
- If dsh-remote is also installed, its **Add workspace** dialog takes precedence.

### New workspaces from a project

**Add workspace › From a project** makes a workspace from a Git worktree of a project, on this computer or a saved machine. It is part of [Remote Terminals](../remote-terminals/README.md), and the tab appears once that plugin is installed.

### Integrated workspace tools

In a conversation on a remote workspace, the right sidebar's **Workspace files** (and its shortcut, ⌘P on macOS) opens the remote files instead of the empty local anchor, and each file chosen there opens in a tab of its own beside the list, as in DSH's own file browser. **Remote workspace** there opens sync; file links in the conversation open just that file. In local conversations, Workspace files is DSH's own and Remote workspace is not listed. All the tools, files included, are also in **Settings → Remote agents → Remote workspace**. They follow the current conversation's verified machine and directory. No separate `dsh-remote` installation or second machine registry is required.

- **Files:** browse directories, create files/folders, search text, edit UTF-8 files in VS Code's editor (Monaco, with highlighting, a minimap, find and replace, the command palette and a status bar), preview images, switch Markdown and SVG files between source and rendered view, rename/delete files, and upload/download binary files. CRLF files stay CRLF. A new file opens right away; ⌘/Ctrl+S saves, the close button closes the file, and the clear button or Escape ends a search. Unsaved edits block opening another file but not browsing folders. Saving checks the file's SHA-256 revision and refuses stale edits; **Reload file** fetches the latest version. The editor limit is 256 KiB and the transfer limit is 50 MiB per file. File operations stay inside the verified remote workspace and reject symlinks that escape it. Native session file links open the remote editor after the active workspace has been verified.
- **Terminals and TUI conversations:** remote terminals that outlive DSH, **Remote Claude** and **Remote Codex** in the terminal's shell menu, and conversations whose view is Claude Code or Codex itself are in [Remote Terminals](../remote-terminals/README.md), a plugin of its own since 0.2.130. Install it beside this one; it works on the machines saved here.
- **Sync:** preview **Pull remote → local mirror** or **Push local mirror → remote**, then **Apply preview**. A three-way content comparison preserves files changed on both sides as conflicts. The preview lists copies and deletions; changes to that plan require another preview. Git, dependency/build directories, plugin metadata, symbolic links and names containing a line break are skipped. Sync is explicit and does not run while an agent edits files unless you request it.

Ordinary DSH models also receive a **`remote_workspace`** tool for session-scoped file access and commands, plus guidance to read remote `AGENTS.md`. Its changes follow the conversation's DSH permission like DSH's own tools: **Full access** and **Auto review** run file changes and commands without a prompt, **Workspace Write** edits files inside the workspace directly and asks before commands, and **Read Only** or a custom permission asks before every change. Remote CLI models continue using their own native tools and approval modes.

### Supported hosts

Workspaces created by dsh-remote continue to work.

This implementation supports **Linux/macOS remote hosts with system OpenSSH key/SSH-agent authentication**. Files, search, sync and commands need only a POSIX shell, standard utilities and `sha256sum`, `shasum` or `openssl`, so hosts without Node.js, such as Docker hosts with a standalone Codex, work too. Remote CLIs that outlive DSH still need Node.js 18+ on the login PATH. Put authentication and jump-host settings in `~/.ssh/config` and load encrypted keys into your SSH agent. Native Windows remote workspaces and password/OTP authentication are not included.

Keep `$DSH_HOME/remote-workspaces/` and its metadata.

## Unified remote sessions

Open **Settings → Remote agents → Open sessions**. There is no remote sessions entry in the sidebar. The list includes main-chat bindings and delegated agents, with search by title, CLI, host or path, and **In progress / History / Archived** views. The default view shows running tasks, pending approvals and errors; idle sessions move to History and remain available to continue. The two-pane interface groups sessions by date and shows the project, host and update time. Read conversations on the right; permission modes and renaming are in the header’s Session options. Archived sessions are linked at the bottom of the list. Agent replies render Markdown, and consecutive tool calls are collapsed into an expandable group.

Choose **Permission mode** when creating a session or while an existing session is idle. Changes apply to the next message. In a main chat, the DSH permission replaces this choice with its next message. Claude defaults to **Remote CLI settings**, preserving the remote account/project permission configuration instead of forcing `default`. Existing sessions keep their explicit mode; select **Remote CLI settings** to return to the remote default. DSH workspace access does not grant remote CLI permissions. **Accept edits** still asks for commands requiring approval; **Full access** permits commands and edits without individual approval.

**Hosts you connect to as root:** Claude Code refuses to skip permissions as root and exits with an error. When it starts Claude in **Full access** or **Remote CLI settings** on a root account, the plugin sets `IS_SANDBOX=1` so that Claude starts normally; other permission modes do not set it. Claude can then run any command as root without asking, so choose **Full access** only on machines where you accept that. TUI conversations do not set it: if the root account's Claude settings make `bypassPermissions` the default, Claude in a TUI still shows this error.

**Claude Auto:** select **Auto · safety checks** to launch or resume with `--permission-mode auto`, including existing sessions saved before this option was added. This keeps Claude's classifier checks. **Remote CLI settings** uses the non-interactive `claude -p` default, which can differ from an interactive terminal: with Claude Code 2.1.302+, an unset permission mode starts `-p` in Manual even when a terminal starts in Auto. The plugin does not change saved modes automatically. Auto requires a CLI/model/account that supports it. See [Claude permission modes](https://code.claude.com/docs/en/permission-modes#tool-calls-denied-in-claude--p-and-agent-sdk-runs).

Native DSH approvals remain one-time grants. When Claude supplies matching allow-rule suggestions, its pending request in this panel also offers session or project approval. Review **Details** before selecting one: project approval sends only those native rules to the remote `.claude/settings.local.json`, so matching requests can be approved in future sessions. The plugin does not create global allow rules or save a one-time approval as a lasting grant. Requests without a suitable suggestion continue to offer one-time approval.

- **Create:** select a remote DSH workspace, then choose its machine's CLI and model and describe the task. The session uses the verified remote directory, translating local workspace anchors. Creation rechecks the workspace so a changed directory or machine cannot use a stale selection.
- **History and follow-ups:** read streaming output, expandable reasoning and tool details, and load earlier history. Send follow-ups to background agents here; use **Open in main chat** for bound conversations so their native DSH history stays consistent.
- **Approvals:** the sidebar counts sessions needing attention. Dismissing a native DSH approval keeps the request pending; respond in the session panel using the CLI's actual permission choices or question form. **Stop** explicitly interrupts the turn.
- **Manage:** rename remote records, archive and restore them. Use **Archive listed history** to archive the current search results in History. Each session is checked again before archiving so newly active sessions and pending approvals are skipped. Archiving preserves history and ends the CLI process. These actions affect the remote record, not the native DSH conversation's title or archive state.
- **Delivery:** wait for the current turn or stop it before sending. After a lost response, **Check delivery** checks the same message without resending it. Pending messages survive reloads and reopening the session within the same browser tab.

Closing the panel leaves background work running, and so do quitting DSH and losing SSH; see [Persistence and recovery](#persistence-and-recovery). Sessions show **Reconnecting** while DSH re-establishes their SSH connection.

## Delegation from DSH


DSH's own agent gets six tools to hand work to remote CLIs, the counterpart of Paseo's `create_agent` and `send_agent_prompt`:

| Tool | Purpose |
| --- | --- |
| `remote_agent_list` | Hosts, recent projects and agents with their status |
| `remote_agent_providers` | CLIs, models, modes, thinking levels and speeds available in a remote project |
| `remote_agent_create` | Start an agent with a self-contained task; waits for its reply by default |
| `remote_agent_send` | Follow up with an agent (ID or prefix); refuses to interrupt a working agent unless `interrupt: true` |
| `remote_agent_wait` | Wait for one or more agents and return their replies; a timeout leaves them running |
| `remote_agent_stop` | Interrupt an agent's turn |

Ask DSH something like *"have Codex on build-box fix the failing tests in /srv/app, and Claude review /srv/web in parallel"*. Use `remote_agent_list` to inspect their status and `remote_agent_send` to steer them in the conversation.

- While a tool waits, the remote agent's approval requests and questions appear as **native DSH prompts** in the conversation. A one-time DSH approval never selects a session-wide CLI permission. If you dismiss a prompt, the request stays pending and the tool reports it; `remote_agent_wait` can show the prompt again.
- Starting an agent in a mode that doesn't ask before acting (full access, bypass permissions) requires your explicit approval.
- Stopping the DSH response stops waiting but does **not** stop the remote agents, matching Paseo's independent agents. Stop them with `remote_agent_stop`.
- Remote CLIs a conversation started appear in that conversation's native **sub-agents** list at the top, merged with its own sub-agents. Clicking one opens a read-only, live view of the remote conversation; continue, stop or answer approvals with the tools above or in the sessions panel. Only tasks started directly by that conversation are listed, and viewing one never sends a prompt or starts a CLI. This needs a DSH whose slot registry exposes `entries` and `subscribe`; otherwise the list is unchanged.
- The tools load when DSH provides agent tools and approvals. Native model routes and settings work without the delegation tool registry.

## Sharing DSH MCP servers and skills

**Settings → Remote agents → Share with remote CLIs** lists the MCP servers and personal skills configured in DSH. Remote CLIs started afterwards receive what is selected; CLIs already running keep what they had.

- **MCP servers (off by default).** Tools run in DSH on this computer; the remote CLI gets a proxy. A call runs as the DSH conversation that started the CLI: a main-chat session's own conversation, or the conversation that delegated the task. DSH permission rules, approvals and hooks therefore apply, and MCP credentials never leave this computer. The CLI pre-approves these proxies, so DSH alone decides whether to ask. Remote CLIs see each server as `dsh-<name>`, for example `mcp__dsh-github__create_issue`. Sessions created directly in the sessions panel belong to no DSH conversation and receive no MCP servers.
- **Skills (on by default).** Personal, bundled and plugin skills are copied to `~/.dsh-remote-agents/shared` on each machine, including resources such as `scripts/`; unchanged skills are not sent again. Project skills are not copied: the remote CLI finds the remote project's own skills. Claude Code loads them as the `dsh` plugin (for example `dsh:release-notes`). Codex, DSH, Grok and CodeBuddy load them with the `load_skill` tool of an MCP server named `dsh`, which runs on the remote machine and needs no DSH connection.
- **Connection.** Each machine uses one SSH reverse forward to a Unix socket under `~/.dsh-remote-agents/bridge` that only your account can open; each task has its own token, and DSH on several computers can share one remote account. While DSH is not connected, a proxy still lists the tools it last saw and calls return a message saying DSH is disconnected; they recover once DSH reconnects. If the server forbids Unix socket forwarding (`AllowStreamLocalForwarding no`), the settings page shows the error; skills are unaffected.
- **Per CLI:** Claude Code uses `--plugin-dir`, `--mcp-config` and `--allowedTools`; Codex uses `-c mcp_servers.<name>…` overrides with `default_tools_approval_mode = "approve"`; ACP CLIs (DSH, Grok, CodeBuddy, Antigravity) use `mcpServers` in `session/new`. These are launch options only; the remote CLI's own configuration files are not changed.

## Agent teams

With NanmiCoder's [`dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) (0.1.28 or later) installed, team members can use a remote CLI as their model, while the captain stays a DSH model such as DeepSeek. Name each member's model in the `/agent-teams` goal, for example "the reviewer uses Codex on this machine", or give a member `provider: remote-cli-codex` and the model's ID from the model menu in a team profile. When the team works in a remote workspace:

- **DSH model members**, such as DeepSeek, read and write the remote files with `remote_workspace`. Members keep the captain's permission: with **Workspace write**, a member edits files in the workspace directly. A remote command has no sandbox and needs approval, which nobody can give in a member's session, so it is rejected and the member reports it to the captain as a blocker. Give the captain **Full access** to let such members run remote commands.
- **Remote CLI members** run in the workspace's remote directory, each in its own CLI session. Assignments and coordination from the captain reach the CLI as prompts. The CLI gets the four member tools (`agent_teams_claim_task`, `agent_teams_update_task`, `agent_teams_send_message`, `agent_teams_status`) from an MCP server named `dsh-agent-teams`, and claims, updates and reports its tasks with them. The tools run in DSH as that member; captain tools are never given to the CLI. No MCP server needs to be switched on under **Share with remote CLIs**, but as with shared MCP servers the machine needs Node.js and must allow the SSH reverse forward. Without the tools, the CLI reports its result in its last reply, which also reaches the captain.
- **Nobody approves.** A member's session asks no one: Codex works in the sandbox matching the DSH permission and never asks for more; Claude Code, with **Workspace write**, edits files without asking and runs commands in its own sandbox, which can write only to the workspace (on a host where that sandbox is unavailable, commands are rejected). A request that still needs approval is denied at once; the CLI goes on and reports what it could not do to the captain instead of waiting.
- **To make a CLI the member itself, set the member's model to that CLI.** Before confirming the team's plan, check each member's model: a coder meant to be Codex should have this machine's model from the Codex group. A member that is still a DSH model may hand its work to a remote CLI with `remote_agent_create`. That CLI gets no team tools and only works for the member; it runs with the member's permission and asks no one either (without a mode, it gets the mode of the member's sandbox, not the remote CLI's own settings, which may be read-only). A mode beyond the member's permission, such as Full access for a member with Workspace write, still needs approval and is rejected in a member's session.
- Members' CLI sessions also appear in **Open sessions**, where you can see what they did.

## Supported CLIs

| CLI | Direct protocol |
| --- | --- |
| Claude Code | Native stream-json / control channel |
| Codex | Native `codex app-server` over stdio |
| DSH | ACP v1 `dsh --profile acp` |
| Grok | ACP v1 `grok agent --no-leader stdio` |
| CodeBuddy | ACP v1 `codebuddy --acp` |
| Antigravity | ACP v1 `agy acp` (Antigravity CLI 1.5.9 or later) |

Detection initializes each CLI's protocol and reads its model and mode catalogs without sending a prompt. ACP supports both legacy model/mode fields and `configOptions`, including model-specific reasoning choices. A listed model does not guarantee account access or quota. Install and sign in to each CLI on the remote machine first.

DSH uses the remote `acp` profile's providers, models and credentials. Grok runs with leader mode disabled. Over SSH, Antigravity keeps its own sign-in, separate from the desktop app's keychain one: run `agy acp --login` once in a terminal on that machine. Version 1.5.8 answers every session with "Authentication required" even when signed in; `agy update` fixes it. References: [DSH ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md), [Grok Build](https://docs.x.ai/build/overview), [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp), [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options).

## Hosts

**Remove** stays available when a host is offline or SSH fails. Hosts with saved sessions ask for confirmation first. **Remove host and sessions** stops attached CLI processes and permanently deletes that host’s plugin sessions (including archived sessions), saved output and model catalog without reconnecting over SSH.

Add machines under **Settings → Remote agents**. Pick a `Host` alias from the DSH machine's `~/.ssh/config` (including `Include` files) or enter `build-box`, `user@build-box` or `ssh://user@build-box:2222`. The original alias is saved, so OpenSSH resolves `HostName`, `User`, `Port`, `IdentityFile` and `ProxyJump` when connecting. The picker never expands wildcards, runs `Match exec` or opens a connection.

The DSH server needs noninteractive key or agent access and verified host keys (`BatchMode=yes`, `StrictHostKeyChecking=yes`). Passwords are not stored. Remote machines need only SSH and the signed-in CLIs, not this plugin. Each host pins its SSH machine identity; if it changes, add the machine again.

Commands to one machine share a single SSH connection (OpenSSH `ControlMaster`), so only the first pays for the SSH handshake; the connection closes a minute after its last command. Its socket lives in `ssh/` beside the plugin's state, a private directory. Past the server's session limit (`MaxSessions`, 10 by default), or where a socket cannot be used (Windows, a state directory path that is too long or has spaces), commands open connections of their own as before. Every connection checks that the machine still answers every 15 seconds and ends after 45 seconds of silence, so a connection lost while the computer slept or changed networks is reopened instead of hanging.

Before running discovery, a CLI or a workspace command, SSH loads the remote user’s interactive login environment for Bash, Zsh and Fish. Browsing, reading, writing and searching workspace files, and Git requests that only read the repository, skip it: they need nothing it sets up, and its startup often took longer than the request. This includes proxy, authentication and configuration-directory variables that may be set only in interactive startup files. Startup output is separated from CLI protocol output, and startup scripts cannot consume CLI input. Other login shells keep the POSIX launch path. The plugin retains an already configured Node.js ≥22. If the current runtime is too old, the plugin selects a compatible installed nvm or Homebrew runtime. Without one, it keeps the existing environment and reports CLI errors; it never installs or upgrades Node automatically.

### This computer

Every DSH also lists the computer it runs on, under that computer's name and marked **This computer**. Its CLIs run here, without SSH, in the folders you add with **Add workspace › This computer**: open such a folder, and the picker shows the models of the CLIs installed and signed in on this computer. They are detected the first time a conversation opens in one of its folders; a CLI installed or signed in later shows up within an hour, or at once with **Refresh models**. Each CLI starts from a fresh login environment, as over SSH, not from DSH's own variables, and keeps running while DSH restarts. Shared MCP servers reach DSH through a socket under `~/.dsh-remote-agents/bridge` that DSH opens itself. This computer cannot be removed; switch off the CLIs you do not want instead. It is not offered as a remote machine: folders here keep DSH's own files, Git and terminals.

To use the CLIs of another computer, open that computer's DSH, for example with [DSH Link](../link/README.md), or save it as an SSH machine as before.

### Uploaded attachments

Paste or upload images and files in DSH’s normal composer. An attachment-only message is supported. Each message’s copies live under `.dsh-remote-agents/attachments/<task>/<message>/` in the remote workspace, with private directories, read-only files and SHA-256 verification. The files remain available for follow-ups and resumed CLI sessions; you can remove the remote attachment directory when it is no longer needed. Deleting a plugin session clears its local staging copies.

Files are streamed without buffering the entire upload in memory. Images use DSH’s normalized request versions (up to a 1568-pixel edge and a 4 MiB target); each must fit the CLI’s 5 MB limit, with at most 20 images and 32 MiB of image data per request. A failed upload does not start a CLI turn, and retrying an already recorded message does not upload or send it again.

### Images in replies

The DSH chat shows only files on the DSH computer, so images from the remote machine are copied into `chat-images/` beside the plugin's state, one file per distinct image.

- **Images the CLI looks at or makes.** Images Claude or Codex uses with a tool appear in the reply where it used them, each once per reply: screenshots and pictures Claude opens with Read, images Codex looks at with `view_image` or generates, and images an MCP tool returns. When the CLI's output holds the image, as for Claude, MCP tools and generated images, the copy comes from there, so it is the image the CLI saw even if the file changed later or lies outside the workspace; image bytes are not written to the saved history. Codex's `view_image` names only a file, which the chat fetches from the remote machine (any image file up to 20 MB that the SSH account can read) when it shows the reply. ACP CLIs are not covered yet.
- **Images the CLI links.** A Markdown image in a reply that names a file in the remote workspace, such as `![Shot](shots/a.png)`, is downloaded and shown. Paths outside the workspace and images over 20 MB stay as alt text.

## For other plugins

The service `remoteAgentsMachines` (version 1) lets another DSH plugin work on the machines saved here without keeping a second registry or its own connections: the saved machines, a conversation's verified machine and directory, the machine's shared SSH connection for the plugin's own commands, its file and Git operations, and turning a remote directory into a DSH workspace. The contract is `RemoteAgentsMachines` in the private `packages/remote-core`. [Remote Terminals](../remote-terminals/README.md) is built on it, and provides `remoteAgentsWorktrees`, which this plugin provided until 0.2.129.

## Install and upgrade

Requires Node.js ≥22.15.0 and DSH ≥0.2.1-rc.2, <0.3.0. Build and install the archive into a DSH profile:

```sh
pnpm --filter dsh-remote-agents pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-remote-agents-0.2.62.tgz"
```

Restart that profile and refresh the browser. For the Desktop app, fully quit it and use the app's bundled `dsh` with `--profile desktop`.

See the [changelog](CHANGELOG.md) for what changed in each version and what to do after upgrading.

## Persistence and recovery

State lives at `$DSH_HOME/storages/dsh-remote-agents/state.json` (default `~/.dsh`), with output in adjacent `events/*.jsonl`. Files use mode `0600`, and `stateDir` overrides the directory. Saved output stays readable while a host is offline.

- Creation persists the request ID before any remote action, then the native session ID before any prompt, so retrying a lost response never starts a second agent. A start interrupted by a DSH restart remains saved so retrying the response can finish it.
- Each message is recorded by ID before it is sent and is never resent automatically. Only the CLI's own acknowledgment marks it delivered; otherwise the message shows **Delivery not confirmed**.
- **Remote CLIs outlive DSH.** On SSH hosts with Node.js 18 or newer, each CLI runs under a small relay installed in `~/.dsh-remote-agents` on that host. The relay owns the CLI process and appends its output to a private log, so the CLI keeps working when DSH quits, crashes, reloads the plugin or loses its SSH connection. Without Node.js 18, or when the relay cannot be installed, the CLI is not started: the response or session shows why and what to fix, and retrying after the fix starts it under a relay.
- **Automatic recovery.** When DSH starts, it reattaches to every relay and reads the output produced while it was away, starting from the last byte it saved; nothing is lost or recorded twice. Running turns, tool calls and unanswered approvals are restored; answered approvals are never asked again. A lost SSH connection is retried automatically (backing off to every 30 seconds) and the session shows **Reconnecting**; only an actual CLI exit fails a turn.
- **No duplicate input.** Prompts, approval answers and interrupts carry IDs that the relay delivers once, so reconnecting never repeats them. An approval answered while the host is unreachable is saved and delivered after reconnecting.
- **Stop and termination.** **Stop** interrupts the turn and keeps the CLI process. Archiving, deleting, changing the mode or model, and releasing an idle session for a new one end the relay. When the host is unreachable, deleting and archiving still finish immediately; the relay is stopped and removed the next time DSH reaches the host.
- **Relay limits.** Up to 32 relays per SSH account, 512 MB of output each, 128 MB per input line. A CLI with no DSH attached and no activity for 24 hours is stopped; its output is kept. Finished relays are deleted once DSH has read them, or after 14 days.
- **Main conversation.** Quitting DSH or reloading the plugin ends the response normally, with a note that the remote CLI is still working, instead of marking it failed; unfinished tool calls show as still running. When DSH opens the conversation again and has reattached the CLI, it catches up by itself: a **Remote CLI output produced while DSH was disconnected** notice starts a response that shows the output produced meanwhile and follows the remote turn until it finishes. Nothing is sent to the remote CLI. This happens only while the conversation still uses that remote model; otherwise, or if you send a message first, the next message shows the missed output before its own request. A response you stop has nothing to catch up on, unless the stop could not reach the remote CLI; what the CLI goes on to write is then shown the same way. **Retry** on the cut-off response replays it in full. None of these resends the original prompt. A response cut off by a crash or a forced quit is still shown as interrupted by DSH, and catches up the same way.
- CLIs that cannot resume a native session (ACP without `loadSession` or `session/resume`) keep running under the relay, but show **Ended** once their process ends, with output kept.
- Each host keeps up to eight CLI processes. When full, the least recently used idle agent that can resume is released. Working agents, pending approvals and in-flight messages are never released.

Earlier Paseo-based task records remain readable but are not converted.

## Development

```sh
pnpm --filter dsh-remote-agents check     # typecheck, protocol/integration tests, build
pnpm --filter dsh-remote-agents test:ui   # sessions, approvals, settings, SSH picker and the model menu
pnpm --filter dsh-remote-agents preview:ui
```

Tests cover the native protocols with simulated CLIs over a fake SSH transport, including interrupt-on-send and resume, plus the service and delegation tools with a simulated DSH host. Native-chat tests also load the installed DSH LLM registry and session implementation, exercise durable retry/cancellation/approvals, and connect all six model routes through the real backend to simulated SSH CLIs. Real remote CLIs over SSH have not been exercised by these tests.

Browser tests load the unmodified official DSH 0.2.1-rc.3 model menu bundle and the real slot registry, with a simulated directory transport, plus the built `dsh-model-groups` client as DSH loads it; build that first with `pnpm --filter dsh-model-groups build`. They verify native registration, folding persistence, search, hidden-option keyboard protection, reasoning selection, failure recovery, narrow layouts and plugin disposal. The Desktop app itself is not launched by these tests. Run `pnpm --filter dsh-remote-agents test:models` for this focused regression. Folding uses the native MenuGroup and documented model-label DOM attributes; unrecognized future markup is left unchanged.
