# Ordinary conversation sharing (`shared-native-v1`)

[中文](native-sharing.zh-CN.md)

Ordinary DSH conversations move through **explicit handoffs and linked continuation copies**. They are not converted into remote CLI conversations, and a GUI-owned native log is never overwritten. Version, publication and deployment status are tracked in the [repository release record](https://github.com/lalaze/dsh-plugins/blob/main/docs/releases/2026-11-09.md). Isolated-runtime acceptance has passed using real DSH **0.2.2-rc.1** services, temporary stores and a stub model. Two physical Macs with real GUI/accounts, and other host versions, have not been verified.

## Supported capabilities

- Ordinary local workspaces with explicit directory mappings, alongside verified SSH remote workspaces.
- Complete user/assistant messages, tool calls/results/streams, existing compaction and the original history it masks. Continuations can produce new manual or automatic compaction, titles and ordinary commands.
- Native files and images. Images transfer actual content while preserving original bytes, SHA-256 IDs and references; source-machine temporary paths are not attachments.
- The receiver's normal tool set, under native sandbox and approval checks. Tools are no longer restricted to `remote_workspace`.
- Durable state for goals, parked input, schedules and continuable child-session trees. Import does not execute work; continuation requires explicit restoration.

**Running OS processes, terminals, tool executions and process-local handles cannot be transported.** This is not a blanket ban on autonomous tasks. Running turns, tools and background jobs must reach a safe boundary, complete or stop first; settled job history can be retained.

## Enable sharing and map workspaces

1. Add the same SSH host/account on both instances. Enable receiving in **Settings → Remote agents → Ordinary DSH conversations** on each device. This receives only explicitly published conversations, without scanning private chats. CLI sharing has an independent switch.
2. For a local workspace, map the **same source project key** to an explicitly confirmed local directory on each device. For example, use Air's source project absolute path as the key, mapping it to directory A on Air and directory B on Mini. Confirm the canonical existing directory. Do not infer mappings from matching folder names, create directories automatically, or use the remote anchor as a local project.
3. Verified remote workspaces retain their verified SSH host, account and remote project. A missing local mapping may leave history available, but must never silently fall back to remote execution. Placement is fixed before import; an active continuation cannot be arbitrarily rebound.
4. **Project code is not synchronized with the conversation.** Prepare code, dependencies and tools separately. Explicit file attachments use the attachment protocol. Configure the ordinary model/provider and required plugins on the receiver; source credentials and profiles are not copied.

## Share, continue and hand off

1. Open the intended conversation, verify its title/ID, and choose **Share and close current conversation**. It must contain complete history; running work must complete or stop. The original native log remains local and receives a durable unavailable model selection against accidental continuation.
2. **Continue here** atomically acquires ownership before importing a **new local native session ID**, attached to the confirmed receiving workspace. The lineage's shared ID remains stable. Handoffs do not overwrite the same session ID on both devices.
3. Read-only history is cold-imported without creating a live Agent or invoking a model/tool. Synchronization polls roughly every 30 seconds. Existing views refresh when the user explicitly opens current history; older views remain preserved and archived.
4. Completed idle turns publish suffix checkpoints, normally after about one second, with polling retries. Handoff freezes restorable state, publishes the final checkpoint and closes the current copy before another device can claim it. Closing the panel/browser does not release ownership.

Every imported Agent uses the **receiver's default preset** and freshly assembled system, runtime-context and tool declarations. At `agent/created`, before input runs, read-only sandbox and `ask` approval are applied, including when child sessions cold-resume. Historical source full-access settings do not become receiver execution permissions. Users may deliberately change local permissions through native DSH controls; import never elevates them automatically.

## Autonomous state and child sessions

- **Goals:** Preserve goal IDs and durable state, not process-local continuation eligibility. Cold import does not call create/resume or start rounds. Explicit restoration rearms continuation; live source goals are paused during freezing.
- **Parked input:** Persist a backup before clearing the source inbox. The receiver parks input instead of consuming it when history opens. A child that has not been natively resumed returns a definite not-accepted result; the user can resume that child normally and explicitly retry.
- **Schedules:** Pause the source with revision/update-time checks. Store receiver-side restoration descriptions first, and create/enable only after explicit restoration. Originally paused schedules do not automatically become active. Expired one-shot schedules keep their original time and are marked expired, not rewritten to run immediately.
- **Child trees:** Cold-import root, child and grandchild logs and attachments. Rewrite only structural identities in headers and each parent's own catalog. Do not globally replace IDs in historical messages, tool text, descriptors or attribution. Scoped control-tool aliases resolve historical IDs while preserving native adjacency and authorization checks. Old presentation links are not guaranteed to locate the new copies.
- **Acceptance receipts:** Distinguish definite non-acceptance, unknown outcomes, accepted work and conflicts. Queue/goal reconciliation uses durable log boundaries, message IDs plus complete envelopes, goal IDs/revisions and native events. Schedule reconciliation uses the saved request/target, pre-existing catalog baseline and creation interval. Insufficient evidence stays unknown: no text-similarity guesses and no automatic resend. Retry requires an explicit action after reconciliation.

Checkpoints carry the complete autonomous-state bundle, not only the root event suffix. Newly created descendants join the same writer guard. Repeated handoffs normalize structural identities for publication without rewriting user text.

## Single writer, failures and recovery

The SSH account's private `~/.dsh-remote-agents/shared-native-v1` directory is separate from CLI `shared-v1`. Records hold a stable UUID, monotonic version, digest, deduplication receipts and a **non-expiring owner/token**. Cross-process exclusive locks serialize CAS operations; private temporary files are fsynced, atomically renamed and directory-fsynced. There is no lease-expiry takeover or offline multiwriter mode. An abnormal registry lock fails closed rather than being automatically removed.

The root and every descendant check the same root ownership before steps, requests/retries, model streams and tool dispatch. Commands, titles and compaction are fenced too. A lost connection rejects new generation/tool dispatch; an already started generation may finish locally, but another instance cannot take an owned record. Checkpoints verify owner/version/digest and the existing event prefix. Unchanged checkpoints are not republished.

Freezing persists backups first. If archive or final checkpoint fails, a stable `pendingFreeze` survives restart and prevents further writing. The user can retry that operation or explicitly roll it back; a new version must not bypass it and lose cleared input. Rollback preserves input and original task state, while execution still requires deliberate restoration.

Restart does not automatically continue the old active copy. Recovery reconciles pending operations, closes the old copy and creates a new continuation from the last confirmed shared checkpoint. Local unpublished tails, originals and rejected input remain available; they are not silently merged or discarded. Native pre-step happens after inbox claim, so refusal cannot undo claim: exact claimed input is preserved for manual recovery, not automatically resent.

When release/archive/withdraw/delete commits but its reply is lost, durable receipts reconcile the result and clear the old token without issuing a second release or overriding a new owner. Canceling failed enrollment first writes an authority tombstone that fences delayed create requests; only confirmed cancellation permits restoring the original conversation. Disconnection or an already claimed record stays closed. Enrollment cancellation and rollback do not silently restart autonomous work.

Archiving retains shared history. Withdrawal/deletion replaces remote payloads with a tombstone but cannot erase native copies already saved on other devices. To continue privately, explicitly fork and select an ordinary model; the new ID is not automatically enrolled. Resolve locally owned/pending state before disabling receiving or removing the SSH host. Registry-lock inspection requires checking the exact process and preserving records, not assuming expiry from a PID or age.

## Content and compatibility boundaries

- At most 32 attachment references per session; 2 MiB per file and 4 MiB per image, supporting PNG/JPEG/WebP/GIF. Attachments total at most 6 MiB across the tree; a snapshot/request is limited to 12 MiB. Autonomous bundles allow at most 64 children and 256 schedules. Excess size errors explicitly instead of truncating context.
- Read attachments only through registered host references and AttachmentStore, validating canonical base64, SHA-256, lengths and metadata. Images use the audited lossless publication adapter, not an arbitrary re-encoding that changes IDs.
- Parse actual message/stream content blocks only. Tool `meta`, schemas and paths in text remain opaque history. A field named `resource` or `spillPath` does not authorize reading a file or justify rejecting ordinary data. Unknown actual content blocks, events/formats or missing required host capabilities still fail explicitly.
- External spill/cache objects and third-party live handles have no verified portable export support. Paths are never guessed and opened. Complete tool output already in the native log transfers unchanged. Authentication, account stores, machine configuration and project directories are not copied.
- Explicitly shared text, tool output and attachments are copied in full; other users of that SSH account may read them. Keep the plugin installed on both devices. It cannot govern manual log edits after uninstall or deliberately created private forks.

## Verification

The current native suite passed **92/92**, and the independent compatibility suite passed **214/214**, with no failures or skips. These suites overlap and must not be summed as unique tests. Typecheck, build and `git diff --check` passed. An earlier whole-package run had failures; no passing whole-repository run is claimed.

Real native services cover images in model input and lossless attachments, ordinary tools/new compaction, three-level child cold resume/permissions/aliases, ScheduleService, goals and admission receipts. The native `read` tool verified temporary directories A→B→A. Model and approval decisions use test substitutes; stores are temporary. Tests do not read real profiles, credentials or sessions, or replace the GUI service.

```sh
pnpm --filter dsh-remote-agents typecheck
pnpm --filter dsh-remote-agents build
DSH_NATIVE_TEST_RUNTIME=/absolute/path/to/runtime/node_modules \
  node --import tsx --import ./packages/remote-agents/test/setup.mjs --test \
  packages/remote-agents/test/native-capabilities.test.ts \
  packages/remote-agents/test/native-runtime-acceptance.test.ts
```

The environment variable points only to installed package code. Tests skipped because no runtime was supplied are not compatibility evidence. Physical-device, real account/GUI and other host-version acceptance remain separate work.
