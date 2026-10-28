# DSH Remote Agents

**English** | [简体中文](README.zh-CN.md)

Use remote Claude Code, Codex, DSH, Grok, CodeBuddy and Antigravity directly in DSH's ordinary model picker and main conversation. DSH connects to each CLI's native protocol over system OpenSSH. **No Paseo daemon, SDK or remote service is required.**
## Main conversation

Each CLI appears as a separate provider in DSH's ordinary model picker:

1. Open **Settings → Remote agents** and add an SSH host and select the CLIs you want to enable. Saving discovers only their models; you can also save a machine first and choose its CLIs later. **No project name or project path is required.**
2. Select a remote workspace in DSH (see [Remote workspaces](#remote-workspaces)), then choose a model labelled with its host under **Claude**, **Codex** or another CLI provider. The native picker and `/model` only show models belonging to that workspace’s machine. Local, missing or unverified workspaces hide remote models. Because the workspace already identifies the machine, the composer button and the menu’s **Model** row show only the model name, such as **Opus 5.5**; the model list shows the host in muted text after each name, and the button’s tooltip shows the full name.
3. Send messages in the normal composer. Conversations execute in **the current workspace’s verified remote directory**, translating dsh-remote mirrors and Claude SSH placeholders. Every send and follow-up checks machine and directory placement again, so an old model selection cannot send to another machine after a workspace switch. Missing remote directories fail explicitly.

Change the CLI checkboxes on a machine card and click **Apply selection**. Disabled CLIs are neither probed nor shown in the model picker; existing agents keep running. New machines start with no CLIs selected, while older saved machines retain their existing provider scope.

The native model-label contribution coexists with other plugins' label renderers. Custom Codex-style composer pickers also omit the host from captions that match a saved remote model catalog, while retaining their full tooltip, reasoning effort and selection controls. Model catalogs and saved selections keep their original names and IDs.

**Collapsible model groups:** click a provider heading, such as **CodeBuddy Code**, to expand or collapse its models. The current model’s group starts expanded; other groups start collapsed. Manual choices are remembered in this browser. Searching expands matching groups, and clearing the search restores your choices. The plugin adds folding to the provider headings inside the native model list. DSH retains the outer menu, model labels, reasoning controls and any additional selection options.

Model catalogs are saved per machine on the DSH server and shared between clients. The same model entry works across workspaces on that machine without per-project duplicates. The picker reads cached models and filters by the workspace’s SSH host, user and port; process-routed workspaces verify the actual machine identity. Use **Refresh models** beside the machine after CLI/account changes or to discover an existing host after upgrading. Discovery uses the remote account's home directory; execution uses the conversation's workspace directory, and project-specific model availability is validated at startup.

- Each DSH conversation and selected machine / CLI has an independent native CLI session, with its working directory bound on the first message. Follow-ups reuse it, including after a DSH restart when that CLI supports resume. Switching models within a CLI resumes that same session; a non-resumable CLI asks you to start a new conversation. Previously separate model sessions remain accessible. Switching machines or CLIs supplies available conversation text as context; DSH's local system prompt, injected workspace instructions and local tool schemas are excluded.
- Replies and thinking stream into the main conversation. Remote tool calls appear as native DSH tool cards; they execute on the remote machine. They are recorded as completed external work, so DSH never executes them again. Approvals and questions use DSH's native prompts.
- The DSH thinking selector uses the CLI's discovered reasoning levels. Claude and Codex follow the conversation's DSH permission (the composer or `/permission`): **Read Only** runs Claude in `default` (ask before tools) and Codex in read-only, **Workspace Write** runs Claude in **Accept edits** and Codex in workspace-write, **Full access** runs both without approval prompts, and **Auto review** runs Claude in **Auto** and Codex in workspace-write. A change applies from the next message and overrides a mode chosen in Open sessions. A custom DSH permission keeps the session's current mode; a new conversation with one uses the remote CLI's own settings. **Stop** or cancelling the response interrupts the remote CLI turn. Quitting DSH or reloading the plugin does not; see [Persistence and recovery](#persistence-and-recovery).
- **Codex Fast:** When the conversation's Codex model offers a faster service tier, a lightning button appears in the composer toolbar, after the permission control. Turn it on and the conversation's next messages use Fast; turn it off to return to the remote Codex configuration, including a `service_tier` set there. The switch is saved per conversation and keeps the same Codex thread. Fast uses more of the remote account's quota. Each model has one picker entry; a conversation still on an old **Fast** entry moves to the model's entry with the lightning on.
- **Usage ring:** a ring before the send button shows how full the remote session's context window is. Hover over it, or click it, to see the remote account's plan limits for Claude and Codex, such as the session and weekly windows. These come from the CLI on the SSH host, so credentials never leave it. Limits are read when the panel opens, cached for five minutes and read again after a turn finishes; use the refresh button to check now.
- **Prompt cache:** the same panel shows input/output tokens, cache reads/writes and the fraction of input tokens served from cache for the latest reported Claude or Codex model request. This is per model request, so a tool loop may update it several times in one turn. Codex also offers an expandable thread total. Counts are saved with the session and remain available after detach or restart. Unreported fields show **Unknown**; a reported zero stays **0**. Cached tokens still occupy the context window. These are CLI-reported token counts, not a billing estimate.
- Lost responses can replay the saved output by message identity without sending the task again. Unconfirmed delivery or an unfinished response after disconnection is reported explicitly. Send a new message to continue the saved session.
- Main chat accepts **text, uploaded images and files**. Claude and Codex receive images through their native protocols; ACP CLIs expose image input only when their initialization reports support. Files are streamed over SSH into the verified remote workspace and supplied as read-only paths for the CLI’s file tools. Only attachments from the conversation are transferred. The CLI uses its own credentials, tools, instructions and context management. DSH summarization runs in a disposable CLI session, separate from the coding conversation.

## Remote workspaces

Use DSH's **Add workspace** to work on a directory of a saved machine. With machines saved, it opens a dialog with two tabs: **This computer** uses the system folder picker as before, and **Remote machine** browses the selected machine's directories over SSH. Choose a folder and **Use this folder** to add it; the remote models of that machine are then available in its conversations. Without saved machines, **Add workspace** opens the system folder picker directly.

- The dialog remembers the last tab and each machine's last folder. Paths may start with `~/`. Hidden folders are listed after **Show hidden folders**.
- Files stay on the remote machine. DSH records the workspace as a local anchor under `$DSH_HOME/remote-workspaces/`, in the same format as the dsh-remote plugin. Use the **Remote workspace** panel for live files and select **Remote workspace** in the native terminal's shell menu for an interactive SSH terminal. DSH remembers that choice for **New terminal** in every conversation; outside a remote workspace it opens your local shell instead, though the tab is still titled **Remote workspace**. The default local Files view and local shells still refer to the anchor.
- If dsh-remote is also installed, its **Add workspace** dialog takes precedence.

### Integrated workspace tools

In a conversation on a remote workspace, the right sidebar's **Workspace files** (and its shortcut, ⌘P on macOS) opens the remote files instead of the empty local anchor, and **Remote workspace** there opens all the tools below. In local conversations, Workspace files is DSH's own and Remote workspace is not listed. The tools are also in **Settings → Remote agents → Remote workspace**. They follow the current conversation's verified machine and directory. No separate `dsh-remote` installation or second machine registry is required.

- **Files:** browse directories, create files/folders, search text, edit UTF-8 files, rename/delete files, and upload/download binary files. Saving checks the file's SHA-256 revision and refuses stale edits; **Reload file** fetches the latest version. The editor limit is 256 KiB and the transfer limit is 50 MiB per file. File operations stay inside the verified remote workspace and reject symlinks that escape it. Native session file links open the remote editor after the active workspace has been verified.
- **Commands and terminal:** run a command in the workspace with separate stdout/stderr, exit status, a 30-second timeout and bounded output. A timeout stops everything the command started. For interactive programs or longer jobs, choose **Remote workspace** in the native terminal's shell menu. Commands and terminals use the remote account's normal privileges. A missing or invalid binding fails explicitly.
- **Sync:** preview **Pull remote → local mirror** or **Push local mirror → remote**, then **Apply preview**. A three-way content comparison preserves files changed on both sides as conflicts. The preview lists copies and deletions; changes to that plan require another preview. Git, dependency/build directories, plugin metadata, symbolic links and names containing a line break are skipped. Sync is explicit and does not run while an agent edits files unless you request it.
- **Tunnels:** save local or reverse SSH forwards and start/stop/remove them. Local forwards bind to `0.0.0.0`; **Open** uses this machine's Tailscale address. Reverse listeners use remote loopback. Definitions survive restart but must be started again. Closing DSH stops tunnels without stopping persistent coding agents.
- **Remote DSH:** start an isolated remote `dsh web` instance, or enter an existing remote loopback login URL, then connect over SSH and open it locally. Starting requires a compatible `dsh` on the remote login PATH; this feature does not install DSH. Managed data lives under `~/.dsh-remote-agents/web-ui/<port>/home`. **Stop managed instance** stops only the process recorded for this workspace. Closing its tunnel leaves the remote instance running. Login tokens are not saved in tunnel definitions.

Ordinary DSH models also receive a **`remote_workspace`** tool for session-scoped file access and commands, plus guidance to read remote `AGENTS.md`. Its changes follow the conversation's DSH permission like DSH's own tools: **Full access** and **Auto review** run file changes and commands without a prompt, **Workspace Write** edits files inside the workspace directly and asks before commands, and **Read Only** or a custom permission asks before every change. Remote CLI models continue using their own native tools and approval modes.

### Moving from dsh-remote

In **Settings → Remote agents**, expand **Import machines from dsh-remote**. Import reuses SSH aliases, skips already registered endpoints, starts with no CLIs enabled, and leaves the old registry, current-machine selection and workspace metadata untouched. Enable the CLIs you need afterward. Existing compatible workspaces continue to work.

This implementation supports **Linux/macOS remote hosts with system OpenSSH key/SSH-agent authentication**. Files, search, sync and commands need only a POSIX shell, standard utilities and `sha256sum`, `shasum` or `openssl`, so hosts without Node.js, such as Docker hosts with a standalone Codex, work too. Remote CLIs that outlive DSH and remote DSH still need Node.js 18+ on the login PATH. Passwords, keychain secrets and native-only authentication/proxy settings are not copied. Move such connection settings into `~/.ssh/config` and load encrypted keys into your SSH agent first. Native Windows remote workspaces, password/OTP authentication and automatic remote DSH installation are not included.

After importing, use **Test connection** and verify live files, terminal and models before uninstalling `dsh-remote`. Keep `$DSH_HOME/remote-workspaces/` and its metadata. The plugin can coexist with `dsh-remote` during migration; uninstalling the old plugin is a separate action.

## Unified remote sessions

Open **Settings → Remote agents → Open sessions**. There is no remote sessions entry in the sidebar. The list includes main-chat bindings and delegated agents, with search by title, CLI, host or path, and **In progress / History / Archived** views. The default view shows running tasks, pending approvals and errors; idle sessions move to History and remain available to continue. The two-pane interface groups sessions by date and shows the project, host and update time. Read conversations on the right; permission modes and renaming are in the header’s Session options. Archived sessions are linked at the bottom of the list. Agent replies render Markdown, and consecutive tool calls are collapsed into an expandable group.

Choose **Permission mode** when creating a session or while an existing session is idle. Changes apply to the next message. In a main chat, the DSH permission replaces this choice with its next message. Claude defaults to **Remote CLI settings**, preserving the remote account/project permission configuration instead of forcing `default`. Existing sessions keep their explicit mode; select **Remote CLI settings** to return to the remote default. DSH workspace access does not grant remote CLI permissions. **Accept edits** still asks for commands requiring approval; **Full access** permits commands and edits without individual approval.

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
- The tools load when DSH provides agent tools and approvals. Native model routes and settings work without the delegation tool registry.

## Supported CLIs

| CLI | Direct protocol |
| --- | --- |
| Claude Code | Native stream-json / control channel |
| Codex | Native `codex app-server` over stdio |
| DSH | ACP v1 `dsh --profile acp` |
| Antigravity | Native `agy` stream-json |
| Grok | ACP v1 `grok agent --no-leader stdio` |
| CodeBuddy | ACP v1 `codebuddy --acp` |

Detection initializes each CLI's protocol and reads its model and mode catalogs without sending a prompt. ACP supports both legacy model/mode fields and `configOptions`, including model-specific reasoning choices. A listed model does not guarantee account access or quota. Install and sign in to each CLI on the remote machine first.

DSH uses the remote `acp` profile's providers, models and credentials. Antigravity needs Node.js 22+ on the remote host for a small inline process forwarder, and **its headless mode denies operations that need interactive approval**. Configure permissions in `agy` first. Grok runs with leader mode disabled. References: [DSH ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md), [Antigravity headless](https://antigravity.google/docs/cli/headless/), [Grok Build](https://docs.x.ai/build/overview), [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp), [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options).

## Hosts

**Remove** stays available when a host is offline or SSH fails. Hosts with saved sessions ask for confirmation first. **Remove host and sessions** stops attached CLI processes and permanently deletes that host’s plugin sessions (including archived sessions), saved output and model catalog without reconnecting over SSH.

Add machines under **Settings → Remote agents**. Pick a `Host` alias from the DSH machine's `~/.ssh/config` (including `Include` files) or enter `build-box`, `user@build-box` or `ssh://user@build-box:2222`. The original alias is saved, so OpenSSH resolves `HostName`, `User`, `Port`, `IdentityFile` and `ProxyJump` when connecting. The picker never expands wildcards, runs `Match exec` or opens a connection.

The DSH server needs noninteractive key or agent access and verified host keys (`BatchMode=yes`, `StrictHostKeyChecking=yes`). Passwords are not stored. Remote machines need only SSH and the signed-in CLIs, not this plugin. Each host pins its SSH machine identity; if it changes, add the machine again.

Before running discovery or a CLI, SSH loads the remote user’s interactive login environment for Bash, Zsh and Fish. This includes proxy, authentication and configuration-directory variables that may be set only in interactive startup files. Startup output is separated from CLI protocol output, and startup scripts cannot consume CLI input. Other login shells keep the POSIX launch path. The plugin retains an already configured Node.js ≥22. If the current runtime is too old, the plugin selects a compatible installed nvm or Homebrew runtime. Without one, it keeps the existing environment and reports CLI errors; it never installs or upgrades Node automatically.

### Uploaded attachments

Paste or upload images and files in DSH’s normal composer. An attachment-only message is supported. Each message’s copies live under `.dsh-remote-agents/attachments/<task>/<message>/` in the remote workspace, with private directories, read-only files and SHA-256 verification. The files remain available for follow-ups and resumed CLI sessions; you can remove the remote attachment directory when it is no longer needed. Deleting a plugin session clears its local staging copies.

Files are streamed without buffering the entire upload in memory. Images use DSH’s normalized request versions (up to a 1568-pixel edge and a 4 MiB target); each must fit the CLI’s 5 MB limit, with at most 20 images and 32 MiB of image data per request. A failed upload does not start a CLI turn, and retrying an already recorded message does not upload or send it again.

## Install and upgrade

Requires Node.js ≥22.15.0 and DSH ≥0.2.1-rc.2, <0.3.0. Build and install the archive into a DSH profile:

```sh
pnpm --filter dsh-remote-agents pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-remote-agents-0.2.23.tgz"
```

Restart that profile and refresh the browser. For the Desktop app, fully quit it and use the app's bundled `dsh` with `--profile desktop`.

**Upgrading from 0.2.35:** Remote workspace files, search, sync and commands no longer need Node.js on the SSH host. They run with its shell and standard tools, plus `sha256sum`, `shasum` or `openssl`, so a host without Node.js, such as a Docker host with a standalone Codex, no longer fails with `node: not found`. The `remote_workspace` tool for DSH models now follows the conversation's DSH permission: **Full access** and **Auto review** run changes and commands without asking (before, Full access rejected every one), and **Workspace Write** asks only before commands. A command that times out now stops everything it started. Remote CLIs and remote DSH still need Node.js 18+. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.34:** The **Remote workspace** panel has a new layout: tabs for its tools, cards with consistent controls, a tunnel list with status dots and icon actions, and a file browser with icons and a clickable path. Its features are unchanged. Refresh the client after updating.

**Upgrading from 0.2.33:** Codex Fast is now a lightning button in the composer toolbar instead of a separate **Fast** entry in the model menu. It is saved per conversation; new conversations start with it off. A conversation still on an old **Fast** entry moves to the model's entry with the lightning on. Each remote model also remembers the reasoning effort its last message used, so the effort survives switching models and restarts. Refresh the client after updating.

**Upgrading from 0.2.32:** The context usage ring sits closer to the model picker. Refresh the client after updating.

**Upgrading from 0.2.31:** Codex has a new **Workspace write · auto review** mode, and DSH's **Auto** permission now selects it: Codex's reviewer subagent approves or denies requests to leave the sandbox instead of asking you. Remote Codex releases without auto review ignore the setting and keep asking you. Saved Codex catalogs gain the mode without a refresh.

**Upgrading from 0.2.30:** Model menu group headings are now as tall as the model rows, with a chevron that turns when a group opens, a count pill and a hover highlight. The Codex subscription menu places itself again after a group folds or unfolds. Refresh the client after updating.

**Upgrading from 0.2.29:** Images that a remote CLI references by workspace path now show in native chat replies. Each image is copied to the DSH host under the plugin's state directory (`chat-images/`). Replies saved before the update still show alt text.

**Upgrading from 0.2.28:** Provider groups fold again when the Codex subscription plugin (`dsh-codex-subscription`) replaces the model menu. That menu shows no provider ids, so its groups remember their folding by provider name. Refresh the client after updating.

**Upgrading from 0.2.27:** In a conversation on a remote workspace, the right sidebar's **Workspace files** and ⌘P open the remote files, and **Remote workspace** is listed there only in remote conversations. Local conversations keep DSH's own Workspace files. Refresh the client after updating.

**Upgrading from 0.2.26:** Adds the integrated **Remote workspace** panel (files, commands, sync, tunnels and remote DSH) and a `remote_workspace` tool for DSH models; see [Integrated workspace tools](#integrated-workspace-tools). Machines saved in dsh-remote can be imported from **Settings → Remote agents**. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.25:** Provider groups in the model menu fold again in DSH builds whose model rows carry no model ids, such as the Desktop app: those groups remember their folding by provider name. Groups that already folded keep their saved choices. Refresh the client after updating.

**Upgrading from 0.2.24:** A conversation whose remote CLI failed to start (for example, because the SSH host had no Node.js) no longer stays stuck with "This agent is still working" after the host is fixed: the next message starts the CLI with that message, keeping earlier messages as context. Restart DSH after updating.

**Upgrading from 0.2.23:** A remote CLI is no longer started when its SSH host cannot run the background relay (no Node.js 18+ on the login PATH, or the relay cannot be installed); the response fails with the reason instead of silently using a direct SSH pipe that ends with DSH. Install Node.js 18 or newer on such hosts. New conversations are titled from your first message instead of DSH's title instruction; existing titles are not changed. Restart DSH after updating.

**Upgrading from 0.2.22:** Claude and Codex in the main chat now follow the conversation's DSH permission (the composer or `/permission`) instead of always using the remote CLI's own settings: Workspace Write runs Claude in Accept edits, Full access runs without approval prompts, and Auto review runs Claude in Auto. The DSH permission overrides a mode chosen in Open sessions from the next message. Restart DSH after updating.

**Upgrading from 0.2.21:** Every turn's usage, main chat included, now reaches `dsh-usage-stats` through the `remote-agents/usage` event with the machine name and remote directory, so usage can be broken down by host and workspace. Main chat no longer reports a turn's total to DSH as model usage, because it spans many model calls and would misstate the conversation's context size. Update `dsh-usage-stats` to 0.1.5 together with this version, or main-chat turns are counted twice. Restart DSH after updating.

**Upgrading from 0.2.20:** Each finished turn now records the tokens it used (Claude Code, Codex, and ACP CLIs that report usage). With `dsh-usage-stats` 0.1.3 or later, they appear under **Remote agents** in **Settings → Usage statistics**: main-chat turns through their DSH model call, delegated agents and turns sent from **Open sessions** through a `remote-agents/usage` event. Turns from before the update are not imported. Restart DSH after updating.

**Upgrading from 0.2.19:** **Add workspace** gains a **Remote machine** tab that adds a saved machine's directory as a DSH workspace. Codex now also offers **Remote CLI settings**, which leaves approval policy and sandbox to `~/.codex/config.toml` on the remote machine. New main-chat conversations and agents DSH starts without an explicit mode use it for both Claude and Codex. Existing sessions keep their saved mode. Restart DSH and click **Refresh models** beside each machine after updating.

**Upgrading from 0.2.18:** Remote CLIs now keep running when DSH quits or SSH disconnects, and DSH reconnects and catches up automatically. This needs Node.js 18+ on the SSH host. Restart DSH after updating; sessions created earlier switch to a relay the next time their CLI starts.

**Upgrading from 0.2.17:** Remote sessions use a two-pane reading layout with active/history views, date groups, bulk archiving, Markdown replies and collapsed tool activity. Permission mode and renaming are in the header’s Session options. Existing history and native CLI sessions remain available. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.12:** Adds image and file transfer from the main composer. Restart DSH and refresh the client after updating; refresh host models to pick up each CLI’s declared image capabilities.

**Upgrading from 0.2.11:** Claude now inherits remote permission settings by default. Permission modes and matching session/project approvals are available in **Open sessions**. Existing sessions keep their explicit mode; stop an active session and select **Remote CLI settings** to inherit the remote default.

**Upgrading from 0.2.10:** Fixes `3: Bad file descriptor` when remote login scripts close inherited descriptors, blocking model discovery or CLI startup. Restart DSH after updating, then refresh the host’s models.

**Upgrading from 0.2.9:** Hosts with saved sessions can now be removed after an SSH error. Confirm removal to delete their plugin sessions and saved output without reconnecting.

**Upgrading from 0.2.8:** Remote CLIs now load the remote shell’s interactive login environment. This addresses authentication failures caused by missing shell environment when the same Claude command succeeds in an interactive terminal. Update and restart DSH, refresh the machine’s models, and retry the conversation.

**Upgrading from 0.2.7:** Remote sessions now open only through settings; the sidebar entry has been removed. Update the plugin and refresh the client.

**Upgrading from 0.2.6:** Main-chat models are filtered by the workspace machine and verified again before sending. Existing conversations can continue only when their machine and directory match. Update the server plugin and refresh the client; machines and model caches need no migration.

**Upgrading from 0.2.5:** Fixes provider folding failing to activate on the real DSH client because the previous version redeclared an existing child slot. The native model seat is now preserved. Restart DSH and refresh the client; saved folding preferences still apply.

**Upgrading from 0.2.4:** Provider headings in the composer model menu now expand and collapse. Refresh the client after upgrading; no machine or session migration is needed.

**Upgrading from 0.2.3:** Per-machine CLI selection is now available, and SSH no longer selects an old nvm runtime ahead of a compatible installed Node. Adjust the checkboxes and click **Apply selection**.

**Upgrading from 0.2.2:** Click **Refresh models** beside each machine to populate the machine-wide model menu. Existing project-bound conversations keep their saved working directories; legacy project routes remain resolvable but are hidden from the new picker.

**Upgrading from 0.2.1:** Remote models are grouped directly under their CLI providers and keep the native composer. A unified Remote sessions entry is available in the sidebar. Saved hosts, projects, conversations and output are preserved; the old aggregate route remains resolvable for saved conversations but is not advertised in the model picker.

**Upgrading from 0.2.0:** Main chat is available through the CLI provider groups. Add a host or refresh its models; existing independent agents and saved output are preserved.

**Upgrading from 0.1.x:** The embedded Claude SSH engine remains removed. This plugin now connects Claude Code through the same direct CLI backend as the other providers. The separate `dsh-claude-ssh` plugin and its data are unaffected. Old main-chat project/binding records are not imported; refresh the host model catalog in settings. Hosts, independent agents and their output carry over.

## Persistence and recovery

State lives at `$DSH_HOME/storages/dsh-remote-agents/state.json` (default `~/.dsh`), with output in adjacent `events/*.jsonl`. Files use mode `0600`, and `stateDir` overrides the directory. Saved output stays readable while a host is offline.

- Creation persists the request ID before any remote action, then the native session ID before any prompt, so retrying a lost response never starts a second agent. A start interrupted by a DSH restart remains saved so retrying the response can finish it.
- Each message is recorded by ID before it is sent and is never resent automatically. Only the CLI's own acknowledgment marks it delivered; otherwise the message shows **Delivery not confirmed**.
- **Remote CLIs outlive DSH.** On SSH hosts with Node.js 18 or newer, each CLI runs under a small relay installed in `~/.dsh-remote-agents` on that host. The relay owns the CLI process and appends its output to a private log, so the CLI keeps working when DSH quits, crashes, reloads the plugin or loses its SSH connection. Without Node.js 18, or when the relay cannot be installed, the CLI is not started: the response or session shows why and what to fix, and retrying after the fix starts it under a relay.
- **Automatic recovery.** When DSH starts, it reattaches to every relay and reads the output produced while it was away, starting from the last byte it saved; nothing is lost or recorded twice. Running turns, tool calls and unanswered approvals are restored; answered approvals are never asked again. A lost SSH connection is retried automatically (backing off to every 30 seconds) and the session shows **Reconnecting**; only an actual CLI exit fails a turn.
- **No duplicate input.** Prompts, approval answers and interrupts carry IDs that the relay delivers once, so reconnecting never repeats them. An approval answered while the host is unreachable is saved and delivered after reconnecting.
- **Stop and termination.** **Stop** interrupts the turn and keeps the CLI process. Archiving, deleting, changing the mode or model, and releasing an idle session for a new one end the relay. When the host is unreachable, deleting and archiving still finish immediately; the relay is stopped and removed the next time DSH reaches the host.
- **Relay limits.** Up to 32 relays per SSH account, 512 MB of output each, 128 MB per input line. A CLI with no DSH attached and no activity for 24 hours is stopped; its output is kept. Finished relays are deleted once DSH has read them, or after 14 days.
- **Main conversation.** After a restart, the DSH conversation still shows the interrupted response. The next message first shows the output the remote CLI produced meanwhile, waiting for that turn to finish, then sends the new request; **Retry** on the interrupted response instead replays it in full. Neither resends the original prompt.
- CLIs that cannot resume a native session (ACP without `loadSession` or `session/resume`) keep running under the relay, but show **Ended** once their process ends, with output kept.
- Each host keeps up to eight CLI processes. When full, the least recently used idle agent that can resume is released. Working agents, pending approvals and in-flight messages are never released.

Earlier Paseo-based task records remain readable but are not converted.

## Development

```sh
pnpm --filter dsh-remote-agents check     # typecheck, protocol/integration tests, build
pnpm --filter dsh-remote-agents test:ui   # sessions, approvals, settings, SSH picker and collapsible model groups
pnpm --filter dsh-remote-agents preview:ui
```

Tests cover the native protocols with simulated CLIs over a fake SSH transport, including interrupt-on-send and resume, plus the service and delegation tools with a simulated DSH host. Native-chat tests also load the installed DSH LLM registry and session implementation, exercise durable retry/cancellation/approvals, and connect all six model routes through the real backend to simulated SSH CLIs. The Antigravity forwarder test uses a real child process. Real remote CLIs over SSH have not been exercised by these tests.

Browser tests load the unmodified official DSH 0.2.1-rc.3 model menu bundle and the real slot registry, with a simulated directory transport. They verify native registration, folding persistence, search, hidden-option keyboard protection, reasoning selection, failure recovery, narrow layouts and plugin disposal. The Desktop app itself is not launched by these tests. Run `pnpm --filter dsh-remote-agents test:models` for this focused regression. Folding uses the native MenuGroup and documented model-label DOM attributes; unrecognized future markup is left unchanged.
