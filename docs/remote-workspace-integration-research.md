# Remote workspaces and Remote Agents integration

Research date: 2026-10-27. This is an integration proposal, not an implemented change.

Follow-up: the New session routing gap described below has since been fixed in this checkout. The form resolves the current session's workspace, filters machines, and submits through a server-verified creation operation. Other proposed integration work remains unimplemented.

## Recommendation

Present one **Remote** workflow: save a machine once, choose its workspace, then use either a DSH model with remote workspace tools or a CLI model running on that machine. Keep workspace services and agent execution as separate capabilities behind that workflow.

Start with an optional bridge to `dsh-remote`, preserving Remote Agents' standalone mode. Consolidate machine identity and workspace resolution before consolidating settings navigation. A combined settings page backed by two independent machine registries would preserve the main source of confusion.

The screenshot's two entries map to distinct responsibilities today:

| Capability | `dsh-remote` | This repository's Remote Agents |
| --- | --- | --- |
| Machine configuration | SSH machine records, authentication options, connection testing | Own SSH host records and enabled CLI selection |
| Workspace selection | Local/remote picker, directory browsing, local mirror metadata | Local/remote picker, directory browsing, compatible empty anchor |
| Coding with a DSH model | `rw_*` remote file/command tools, session-aware workspace instructions | Tools for delegating tasks to remote CLI agents |
| Coding with a remote CLI | Remote DSH Web attach is available as a separate interface | Claude, Codex, DSH, Grok, CodeBuddy and Antigravity in the native model picker/chat |
| Files and infrastructure | SFTP, mirror sync, remote file UI, terminal shell contribution, tunnels | Attachment transfer and verified execution directories |
| Agent lifecycle | Workspace operations and remote DSH deployment/attach | Persistent CLI relay, streaming, approvals, history, recovery, usage |

The workspace feature inventory is supported by the upstream [package manifest](https://github.com/flymysql/dsh-remote/blob/main/package.json), [implementation](https://github.com/flymysql/dsh-remote/blob/main/lib/index.js), [file routes](https://github.com/flymysql/dsh-remote/blob/main/lib/routes-fs.js), and [terminal contribution](https://github.com/flymysql/dsh-remote/blob/main/lib/remote-shell.js). Remote Agents' behavior is documented in its [README](../packages/remote-agents/README.md).

## Baseline and evidence

Inspected this checkout at `ead0ec0483fe4669fa1720b3e78fa02c19eeab7c`, whose Remote Agents manifest reports `0.2.26`. Existing unrelated workspace-tags changes were left untouched.

Inspected an already available `dsh-remote` npm archive, version `0.8.52`, and checked the upstream manifest, which reports the same version. Archive SHA-256: `37a6d840198ed556f7aad6640dca5bff770f02a1bae74bd069b497d5ba995c0b`. Upstream `main` links below are navigational references; the archive was the implementation baseline. Here, “ds-remote” means `flymysql/dsh-remote`, identified by the metadata format already supported in this repository. The abbreviated screenshot alone does not establish a package identity.

Validation performed:

- Ran the existing `remote-workspaces`, `workspace-access`, `workspace-models`, and `workspace-flow` test files: **16 passed**.
- Created a temporary anchor using our `ensureAnchor`, then read it with upstream 0.8.52's actual `resolveMirror`: host, user, port and remote directory matched.
- Sent a fake session-creation request through our actual HTTP handler: it forwarded the local anchor unchanged and never invoked the configured workspace resolver.

No installed profile was changed, no real SSH connection or model task was started, and no live Desktop/Web combination was tested. The tests establish routing and metadata behavior, not end-to-end authentication compatibility.

## What already integrates

Both plugins use `$DSH_HOME/remote-workspaces/<machine>/<directory>/.dsh-remote-meta.json`. Our [anchor implementation](../packages/remote-agents/src/workspace/remote-workspaces.ts) reads/reuses compatible anchors and creates metadata containing `host`, `username`, `port` and `remotePath`. Existing metadata is preserved when reused.

Our [workspace resolver](../packages/remote-agents/src/workspace/access.ts) translates anchors and nested directories into remote paths, matches saved hosts through SSH endpoint resolution, supports recorded aliases, and rejects malformed or escaped bindings. Our [main-chat adapter](../packages/remote-agents/src/chat/native-chat.ts) rechecks placement before sending, so switching workspaces cannot reuse a selected model on another machine.

Our picker registers behind `dsh-remote` in the two single directory-flow slots. With both installed, `dsh-remote` owns Add workspace; Remote Agents remains the fallback. See [client registration](../packages/remote-agents/src/client/index.tsx) and its [priority test](../packages/remote-agents/test/workspace-flow.test.ts).

This is metadata compatibility. It does not share machine records, credentials, SSH host-key stores, or CLI capabilities.

## Gaps that matter

**1. The machine must currently be configured twice.** `dsh-remote` stores machines under `remote-workspaces/machines.json`; Remote Agents stores hosts alongside tasks in its own `state.json`. A workspace created in one plugin does not register a CLI host in the other. Compatible metadata alone cannot make remote models appear.

**2. Authentication success is not interchangeable.** Remote Agents constructs an `OpenSshTransport`, with batch mode and strict host-key checking, from its connection string. It rejects new password storage. `dsh-remote` has native SSH and system OpenSSH backends, credential/keychain handling, and its own native host-key store. Since upstream 0.8.50, SSH config is intended to own host/user/port/key fields, which gives us a useful integration point, but does not make password, OTP, passphrase or host-key handling equivalent. See our [transport](../packages/remote-agents/src/core/ssh.ts), [host validation](../packages/remote-agents/src/agents/service.ts), and upstream [registry](https://github.com/flymysql/dsh-remote/blob/main/lib/registry.js) and [OpenSSH backend](https://github.com/flymysql/dsh-remote/blob/main/lib/openssh.js).

**3. New session bypasses workspace resolution.** The [sessions form](../packages/remote-agents/src/client/sessions/sessions.tsx) takes the active DSH session's local `cwd`, defaults its host selector to the first catalog, and posts that path to `create`. The [HTTP route](../packages/remote-agents/src/http.ts) forwards it to `service.create`. The backend then probes that literal directory on the selected SSH host. For example, a local anchor for `/srv/app` becomes a remote `cd /.../remote-workspaces/.../app`. Usually that fails; if the same path exists remotely, it can select an unintended directory. Main chat already resolves `/srv/app` correctly. The API forwarding behavior was reproduced with a fake service; the remote failure follows from the backend's command construction.

**4. An anchor is not a synchronized working copy.** Remote Agents creates an empty local folder plus metadata. Upstream also initially leaves a mirror empty until sync. Agent execution and file previews should read the remote filesystem directly. Mirror pull/push remains an explicit file-transfer operation, especially while a CLI is editing files remotely. Upstream supplies remote readers and a terminal shell option; installing both plugins does not turn every core filesystem/subprocess operation into a remote one. See upstream [file-link handling](https://github.com/flymysql/dsh-remote/blob/main/lib/client.js) and [sync implementation](https://github.com/flymysql/dsh-remote/blob/main/lib/sync.js).

**5. Upstream does not expose a general connection service.** In the inspected version, machine pools and credential resolution are closures inside `apply`; package exports cover the plugin, client, manifest and bundle patch. HTTP routes expose machines, workspace/status and file operations, with `/api/dsh-remote/*` variants on Connection. They do not provide the streaming process contract required by our CLI protocols. A bridge can use bounded discovery routes initially, but cannot acquire a native SSH channel simply by calling a documented exported pool. See upstream [HTTP transport](https://github.com/flymysql/dsh-remote/blob/main/lib/http-transport.js).

**6. Capability updates need a shared notification path.** Our model admission refreshes on workspace/session changes, focus and Remote Agents/legacy Claude events. It does not explicitly subscribe to `dsh-remote` machine changes. Execution-time checks remain necessary, while an adapter should also invalidate visible catalogs when connections change. See [workspace model integration](../packages/remote-agents/src/client/composer/workspace-models.ts).

## Proposed user workflow

1. Open **Settings → Remote → Machines**. Add/test one machine. Its card shows file access, enabled CLIs and relay readiness as separate states; “SSH connected” alone does not mean a CLI is ready.
2. Use the existing **Add workspace → Remote** flow to select its directory. Show `machine:/remote/path` prominently, with the local anchor kept as internal bookkeeping.
3. Choose an ordinary DSH model or one of that machine's CLI models. A DSH model uses session-bound workspace operations and may delegate; a CLI model uses its own native remote tools and credentials.
4. View files and use the terminal beside the conversation. Inspect tasks through **Remote → Sessions**, with an additional workspace-scoped shortcut. Keep the existing native conversation and approvals.
5. Put tunnels, sync and remote DSH deployment/attach under **Advanced**. Opening another DSH instance has a separate session/settings store; it is not a requirement for running a remote CLI in the local main chat.

Suggested settings tabs are **Machines**, **Sessions**, and **Advanced**. Workspace selection belongs in the native workspace picker; file browsing belongs in the sidebar. This avoids adding another workspace list to settings.

The single settings entry requires cooperation: upstream owns its own section and does not currently publish a settings-content slot for us. Initially retain both entries with clear cross-links and linked machine cards. A coordinated upstream extension slot, or an explicitly maintained combined bundle, is needed before replacing them with one entry. Do not hide another plugin's section through DOM/CSS interception.

## Proposed implementation boundary

Introduce an internal adapter used by Remote Agents, with standalone OpenSSH and optional `dsh-remote` implementations. The following are proposed contracts, not existing upstream APIs:

```ts
interface RemoteWorkspaceBridge {
  listMachines(signal?: AbortSignal): Promise<MachineSummary[]>;
  resolveSession(sessionId: string, signal?: AbortSignal): Promise<WorkspaceBinding>;
  onChange(listener: () => void): () => void;
}

interface WorkspaceBinding {
  connectionRef: { owner: 'remote-agents' | 'dsh-remote'; id: string };
  localAnchor: string;
  remoteCwd: string;
  revision: string;
}
```

Keep connection identity, workspace identity, and task identity distinct. `connectionRef` names the configuration owner; verified machine identity still guards execution. Store CLI enablement/catalogs against that reference. Preserve existing Remote Agents host IDs because model routes and saved tasks refer to them. When linking an upstream machine, add a mapping instead of replacing those IDs or rewriting conversations.

For a first release, link SSH aliases compatible with the existing batch OpenSSH transport. Retain the alias instead of flattening it into `user@resolved-host:port`, so SSH's Host/Match/ProxyJump settings continue to apply. Probe CLI transport separately and explain any authentication mismatch. This shares configuration references, not necessarily one physical socket.

For full authentication coverage, propose an upstream in-process service providing machine-scoped streaming channels and attachment upload, with lifecycle/disposal and capability negotiation. Adapt it to our existing `SshTransport` contract. It must preserve binary streams, backpressure, separate stderr, cancellation and detached relay access. A bounded `rw_exec` response is insufficient. Credentials remain with their owner; the browser and Remote Agents task store receive references and safe capability summaries, not copied secrets.

Workspace creation and browsing also need explicit machine IDs. Upstream's current workspace endpoint uses mutable active-machine state. A shared bridge must not implement operations by changing “current machine” and then issuing a second request: another picker/session can change it between requests.

Keep CLI execution, relay persistence, delivery IDs, usage and approval translation in Remote Agents. Do not forward DSH's `rw_*` schemas to remote CLI models, or replay their displayed native tool cards as local tool calls. Reuse remote file preview/navigation independently of which model generated the link.

## Delivery sequence and acceptance

| Stage | Concrete work | Acceptance |
| --- | --- | --- |
| 1. Correct workspace targeting | Add a session-scoped create operation that resolves server-side `sessionId` to host and remote directory; filter the form's host/catalog; recheck binding revision before launch | Both main chat and New session execute in `/srv/app` for the same anchor; workspace changes invalidate stale submissions |
| 2. Link machines | Add bridge discovery, stable connection references, alias linking and capability/error reporting; preserve standalone operation and existing task IDs | A compatible upstream SSH machine can enable CLIs without entering its address again; duplicate names do not cause implicit linking |
| 3. Join the workflow | Add workspace-scoped sessions/files/terminal actions and coordinated settings composition | One machine/workspace context is visible across models, tasks and file views; both plugin load orders and removal work |
| 4. Broaden transport | Add a negotiated streaming service with upstream, then adapt native authentication | Password/keychain/OTP coverage is demonstrated explicitly; disconnect/restart retains relay recovery |
| 5. Optional advanced features | Expose existing tunnels, explicit sync and remote DSH attach/deploy through adapter capabilities | Unsupported operations are labeled; sync conflicts and ongoing CLI edits cannot silently overwrite files |

Stage 1 is the best first implementation: it closes an independently confirmed routing gap and supplies the common operation the combined workflow needs. Keep explicit cross-host delegation available through its existing host + absolute remote directory contract; do not reinterpret those tool arguments as local workspace anchors.

Required integration checks include two simultaneous sessions on different machines; aliases/ports/users and config changes; missing bindings or removed machines; startup/unload order; CLI absent or unauthenticated; pending approvals and disconnect/reconnect; existing saved task/model IDs; and file links from both DSH and CLI conversations. Test native Windows separately: upstream supports Windows file operations, while our current CLI transport relies on POSIX shell commands and a Node relay. Workspace support must not be advertised as universal CLI execution support.

This proposal favors an optional bridge over a source merge. Directly absorbing `dsh-remote` would also absorb its updater, deployment machinery, telemetry, credential handling and UI maintenance. Those are separate ownership decisions, unnecessary for the first shared-machine/workspace flow.
