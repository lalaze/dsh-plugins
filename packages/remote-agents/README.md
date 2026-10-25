# DSH Remote Agents

**English** | [简体中文](README.zh-CN.md)

One standalone plugin combines the complete Claude SSH integration with a multi-provider remote task panel. DSH directly starts coding CLIs over system OpenSSH and owns discovery, model selection, task output, approvals, cancellation and recovery. **No Paseo SDK, service or daemon is required.**

| CLI | Direct protocol |
| --- | --- |
| Claude Code | Native stream-json / control channel |
| Codex | Native `codex app-server` over stdio |
| DSH | ACP v1 `dsh --profile acp` |
| Antigravity | Native `agy` stream-json |
| Grok | ACP v1 `grok agent --no-leader stdio` |
| CodeBuddy | ACP v1 `codebuddy --acp` |

Discovery initializes the protocol and reads model/mode catalogs without submitting a prompt. ACP supports both legacy model/mode fields and modern `configOptions`, including model-specific reasoning choices. Providers that do not expose models use CLI default. Resuming requires native `loadSession` or an advertised `session/resume` capability; unsupported resume reports an error and retains the saved output. Install and authenticate CLIs on the remote host first. A listed model does not guarantee account access or quota.

DSH uses the remote `acp` profile's providers, models and credentials; it does not inherit the `web` profile's plugin/model overrides. Recovery uses native `session/resume`, with output history retained by this plugin. See the [DSH ACP contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md).

Antigravity directly runs `agy`, reads `agy models`, and resumes with `--conversation`. No Hub bridge or remote-control service is used. The remote host also needs Node.js 22+ for an inline process forwarder that interrupts only its owned agy child; no separate service installation is needed. **Native headless mode denies operations requiring interactive approval**; this panel does not provide per-operation approval for agy. Configure permissions in agy before running tasks. The plugin does not automatically add permission-bypass flags. See [Antigravity headless mode](https://antigravity.google/docs/cli/headless/).

Grok uses the official Grok Build CLI with leader mode explicitly disabled. CodeBuddy uses native ACP stdio. Neither requires a separately deployed service. Protocol references: [Grok Build](https://docs.x.ai/build/overview), [CodeBuddy ACP](https://www.codebuddy.cn/docs/cli/acp), [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options).

## Install and migrate

Requires Node.js ≥22.15.0 and DSH ≥0.2.1-rc.2, <0.3.0. Build/install `dist/dsh-remote-agents-0.4.1.tgz` using the host's plugin installer.

**Disable the old `dsh-claude-ssh` plugin before enabling this merged package, then restart DSH.** Do not delete its data. The embedded engine retains `DSH_OMC_STATE_DIR` (default `~/.local/state/dsh-oh-my-claude`), provider IDs, login, sessions, SSH boxes and remote workspace routing. Move custom native plugin options under this package's `claude` configuration object.

The package contains the full native engine, keeper worker and client controls, including original conversation integration, model directories, Memory, Rewind, Changes, box management and session management. No separate installation of the old package is needed. Its settings are under **Remote agents → Claude SSH**.

## Use

The DSH server must already have noninteractive SSH key/agent access and verified host keys. System OpenSSH uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, SSH config aliases and ProxyJump.

Open **Settings → Remote agents → CLI tasks**, add `build-box`, `user@build-box` or `ssh://user@build-box:2222`, and enter an absolute remote project path. Discover CLIs, select a provider/model/mode/reasoning level and submit instructions. Approvals, questions, tool output, follow-ups and native cancellation appear in the task panel; the composer also has a launcher.

Tasks execute in the selected remote project. Saved workspaces list directories previously used by this panel; arbitrary accessible absolute paths can also be entered. Local project synchronization and automatic worktree creation are outside this release.

## Persistence and recovery

Closing the panel or refreshing the browser leaves tasks running. DSH shutdown, plugin unload or SSH failure disconnects the direct CLI process; uninterrupted execution across those events is not guaranteed. Saved output remains readable while the host is offline. Reconnect resumes the saved native session ID with the selected permission mode and never automatically replays prior instructions.

Creation persists a unique request ID, then the native session binding, before sending any prompt. Messages persist their IDs before sending. Duplicate HTTP requests do not resend admitted instructions. Only native CLI acknowledgments/output confirm delivery; uncertain messages are not automatically retried. Losing the session creation response may create an empty native session on retry, before any prompt is submitted.

Each host keeps up to eight CLI connections. When full, the least recently used idle session that advertised recovery support is released while retaining its output and native session ID. Running tasks, pending approvals and in-flight message admissions are protected, including service-level Store persistence before the backend send begins. Failed persistence releases that protection.

ACP sessions that advertise neither `loadSession` nor `session/resume` stay connected. To free a slot, use “Disconnect session” after the task finishes; the panel warns when recovery was not advertised. Output remains available after disconnection, but continuing that conversation is not guaranteed. Running tasks and pending approvals cannot be disconnected.

Definitive rejection of task creation or a follow-up clears its pending browser record and retains the content for editing; both inputs are limited to 100,000 characters. Timeouts and lost responses retain the original request ID. “Discard saved submission” and “Discard saved message” clear only their local records, without stopping tasks or retracting messages. Check the task list and output before submitting again.

Hosts pin their SSH machine identity. Tasks bind the host, canonical directory, provider and native session. State lives at `$DSH_HOME/storages/dsh-remote-agents/state.json` (default `~/.dsh`); output is stored in adjacent `events/*.jsonl`. Files use `0600`; `stateDir` can override the directory. CLI credentials stay remote and SSH passwords are not stored.

Paseo host/task records from 0.1.x are retained but not converted to direct SSH tasks. Invalid addresses or changed identities fail closed. Add a new SSH host and create new tasks.

## Development

```sh
pnpm --filter dsh-remote-agents check
pnpm --filter dsh-remote-agents test:ui
pnpm --filter dsh-claude-ssh check
pnpm --filter dsh-remote-agents pack:plugin
```

The 40 protocol/service tests, 76 original Claude test files and desktop/mobile browser regressions pass. Protocol tests use isolated transports, the Antigravity forwarder uses a real child process to verify signal interruption, and browser tests use simulated hosts. Local installed Codex, Claude, Grok and CodeBuddy passed initialization/catalog smoke checks; real DSH and agy passed empty-session initialization and recovery without inference prompts. Real tasks and remote SSH environments still need deployment verification. Original Claude attribution and MIT notices are included in `lib/claude/`.
