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
- The DSH thinking selector uses the CLI's discovered reasoning levels. The CLI's default permission mode applies. **Stop** or cancelling the response interrupts the remote CLI turn. Quitting DSH or reloading the plugin does not; see [Persistence and recovery](#persistence-and-recovery).
- **Codex Fast:** Codex models that offer a faster service tier also appear as a separate picker entry, such as **GPT-5.5 Fast · build-box**. Fast uses more of the remote account's quota. Switching between the normal and Fast entries keeps the same Codex thread. The normal entry uses the remote Codex configuration, including a `service_tier` set there.
- **Usage ring:** a ring before the send button shows how full the remote session's context window is. Hover over it, or click it, to see the remote account's plan limits for Claude and Codex, such as the session and weekly windows. These come from the CLI on the SSH host, so credentials never leave it. Limits are read when the panel opens, cached for five minutes and read again after a turn finishes; use the refresh button to check now.
- Lost responses can replay the saved output by message identity without sending the task again. Unconfirmed delivery or an unfinished response after disconnection is reported explicitly. Send a new message to continue the saved session.
- Main chat accepts **text, uploaded images and files**. Claude and Codex receive images through their native protocols; ACP CLIs expose image input only when their initialization reports support. Files are streamed over SSH into the verified remote workspace and supplied as read-only paths for the CLI’s file tools. Only attachments from the conversation are transferred. The CLI uses its own credentials, tools, instructions and context management. DSH summarization runs in a disposable CLI session, separate from the coding conversation.

## Remote workspaces

Use DSH's **Add workspace** to work on a directory of a saved machine. With machines saved, it opens a dialog with two tabs: **This computer** uses the system folder picker as before, and **Remote machine** browses the selected machine's directories over SSH. Choose a folder and **Use this folder** to add it; the remote models of that machine are then available in its conversations. Without saved machines, **Add workspace** opens the system folder picker directly.

- The dialog remembers the last tab and each machine's last folder. Paths may start with `~/`. Hidden folders are listed after **Show hidden folders**.
- Files stay on the remote machine. DSH records the workspace as an empty local folder under `$DSH_HOME/remote-workspaces/`, in the same format as the dsh-remote plugin, so workspaces created by either plugin keep working. DSH's own Files panel and terminal show that local folder, not the remote one.
- If dsh-remote is also installed, its **Add workspace** dialog takes precedence.

## Unified remote sessions

Open **Settings → Remote agents → Open sessions**. There is no remote sessions entry in the sidebar. The list includes main-chat bindings and delegated agents, with search by title, CLI, host or path, and **In progress / History / Archived** views. The default view shows running tasks, pending approvals and errors; idle sessions move to History and remain available to continue. The two-pane interface groups sessions by date and shows the project, host and update time. Read conversations on the right; permission modes and renaming are in the header’s Session options. Archived sessions are linked at the bottom of the list. Agent replies render Markdown, and consecutive tool calls are collapsed into an expandable group.

Choose **Permission mode** when creating a session or while an existing session is idle. Changes apply to the next message, including main-chat follow-ups. Claude defaults to **Remote CLI settings**, preserving the remote account/project permission configuration instead of forcing `default`. Existing sessions keep their explicit mode; select **Remote CLI settings** to return to the remote default. DSH workspace access does not grant remote CLI permissions. **Accept edits** still asks for commands requiring approval; **Full access** permits commands and edits without individual approval.

**Claude Auto:** select **Auto · safety checks** to launch or resume with `--permission-mode auto`, including existing sessions saved before this option was added. This keeps Claude's classifier checks. **Remote CLI settings** uses the non-interactive `claude -p` default, which can differ from an interactive terminal: with Claude Code 2.1.302+, an unset permission mode starts `-p` in Manual even when a terminal starts in Auto. The plugin does not change saved modes automatically. Auto requires a CLI/model/account that supports it. See [Claude permission modes](https://code.claude.com/docs/en/permission-modes#tool-calls-denied-in-claude--p-and-agent-sdk-runs).

Native DSH approvals remain one-time grants. When Claude supplies matching allow-rule suggestions, its pending request in this panel also offers session or project approval. Review **Details** before selecting one: project approval sends only those native rules to the remote `.claude/settings.local.json`, so matching requests can be approved in future sessions. The plugin does not create global allow rules or save a one-time approval as a lasting grant. Requests without a suitable suggestion continue to offer one-time approval.

- **Create:** choose a saved machine, CLI and model, then describe the task. The current DSH workspace path is used on that machine.
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
dsh plugin --profile web add "$PWD/dist/dsh-remote-agents-0.2.19.tgz"
```

Restart that profile and refresh the browser. For the Desktop app, fully quit it and use the app's bundled `dsh` with `--profile desktop`.

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
- **Remote CLIs outlive DSH.** On SSH hosts with Node.js 18 or newer, each CLI runs under a small relay installed in `~/.dsh-remote-agents` on that host. The relay owns the CLI process and appends its output to a private log, so the CLI keeps working when DSH quits, crashes, reloads the plugin or loses its SSH connection. Without Node.js 18 the CLI uses a direct SSH pipe as in earlier versions and ends with DSH.
- **Automatic recovery.** When DSH starts, it reattaches to every relay and reads the output produced while it was away, starting from the last byte it saved; nothing is lost or recorded twice. Running turns, tool calls and unanswered approvals are restored; answered approvals are never asked again. A lost SSH connection is retried automatically (backing off to every 30 seconds) and the session shows **Reconnecting**; only an actual CLI exit fails a turn.
- **No duplicate input.** Prompts, approval answers and interrupts carry IDs that the relay delivers once, so reconnecting never repeats them. An approval answered while the host is unreachable is saved and delivered after reconnecting.
- **Stop and termination.** **Stop** interrupts the turn and keeps the CLI process. Archiving, deleting, changing the mode or model, and releasing an idle session for a new one end the relay. When the host is unreachable, deleting and archiving still finish immediately; the relay is stopped and removed the next time DSH reaches the host.
- **Relay limits.** Up to 32 relays per SSH account, 512 MB of output each, 128 MB per input line. A CLI with no DSH attached and no activity for 24 hours is stopped; its output is kept. Finished relays are deleted once DSH has read them, or after 14 days.
- **Main conversation.** After a restart, the DSH conversation still shows the interrupted response. The next message first shows the output the remote CLI produced meanwhile, waiting for that turn to finish, then sends the new request; **Retry** on the interrupted response instead replays it in full. Neither resends the original prompt.
- CLIs that cannot resume a native session (ACP without `loadSession` or `session/resume`) keep running under the relay, but show **Ended** once their process ends, with output kept. Direct (non-relay) sessions end with DSH; the next message reattaches the saved native session without replaying anything.
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
