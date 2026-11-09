# DSH goals in remote Claude main chat

Remote Claude selected in the ordinary DSH model picker can use the current conversation's native DSH goal after explicit per-session opt-in. **The bridge is off by default.** The optional `dsh-goal` MCP bridge exposes only `create_goal`, `get_goal` and `update_goal`. This does not require enabling general MCP sharing. Other CLI providers, terminal/TUI conversations and delegated CLI tasks do not gain this bridge.

## Requirements and first use

The DSH host must provide the public goal, goal-tool and goal-round-driver plugins, plus the batch tool executor and agent initiator APIs. Verified against `@deepseek-ai/*@0.2.2-rc.1`. The scoped executor must advertise the three direct goal calls through its public `describe()` API. PTC (which accepts only `run_code`) and missing executors are explicitly unsupported: the bridge fails closed and does not replace or bypass the selected executor. Older hosts or hosts without goal services keep ordinary remote chat; they do not gain goal tools. Claude must supply native `claudecode/toolUseId` MCP metadata; missing identity is rejected. Existing SSH/Node.js MCP bridge requirements apply.

Add the exact **DSH session ID** (not the remote task ID or Claude native session ID) to the existing `dsh-remote-agents` plugin configuration:

```json
{"claudeGoalSessions":["the-exact-dsh-session-id"]}
```

The default `[]` disables the bridge for every session. Unlisted Claude chats keep their persistent process and background work, even when goal services are installed or another session opts in. Removing an ID and reloading revokes access; no synthetic message or model request can opt a session in. No new UI is required.

After installing a build containing this change and applying this configuration, reload the remote-agents plugin or restart DSH. **This source change does not deploy itself.** For each newly delivered goal-enabled Claude turn, the adapter waits for prior work, releases the idle Claude process, then resumes the **same native Claude session ID** with a fresh process and MCP proxy. Existing receipts are replayed without a new grant or restart. No manual archive/restore is required. This adds launch latency and ends in-process background work at the turn boundary; it is the cost of isolating MCP authority across turns. **Opt in only if ending in-process background tasks between turns is acceptable.** Persistent goal-enabled operation has not been validated. Unlisted Claude chats and other CLI providers retain their existing process lifecycle.

1. Choose the remote workspace and a remote **Claude** model in the main chat.
2. Ask, for example: “Create a DSH goal to review these tests and fix failures; continue until verified. Limit it to 5 automatic rounds.”
3. Ask “What is the current DSH goal?” to inspect its objective, revision and state. Use the normal DSH goal UI to inspect it too.
4. Ask “Pause this goal” to pause it. Resume a **paused** goal through the DSH goal UI or native goal command. The native model tool deliberately rejects resuming a paused goal, even after a human asks the model.
5. After restarting/resuming a session, an otherwise active goal is **disarmed**. A direct human request to continue allows Claude to call native `update_goal` with `action: "resume"` to rearm it. The bridge never rearms a restored goal itself.

The native driver starts automatic rounds. Each round goes to the same bound Claude session, carrying the original goal ID, revision, round and instruction text as automatic context. It is not presented as a fresh human request. New human input retains priority according to DSH's normal inbox/driver behavior. Completion, blocking, pause, Stop and the round limit use native DSH semantics. Closing DSH leaves remote work running as before, but its goal tools have no authority while the local driver is absent. Reopen the conversation to catch up, then explicitly continue when needed.

## Tool contract and permissions

These are the actual DSH tool schemas, not the Codex API's `status`/`token_budget` format:

- `create_goal`: `objective`, optional `max_goal_rounds`.
- `get_goal`: no arguments. Returns `goal` (possibly null), and `activation` when a goal exists.
- `update_goal`: `goal_id`, `revision`, `action`; optional `objective`, `max_goal_rounds`, `blocked_reason` as permitted by the action. Actions are `edit`, `pause`, `resume`, `complete`, `blocked`.

Read the current goal before updating it. Stale revisions are rejected. Create/edit/pause/resume require direct human input in a root agent's open turn; scheduled messages, team instructions and automatic continuations do not grant that authority. Complete/blocked also work in the exact native goal round. The native configured blocked-round threshold applies. Native tool errors remain authoritative.

The transport credential binds **goal namespace + remote task + DSH session + remote message + random launch epoch**. Each new process gets a uniquely named, immutable credential file. A permanent proxy reads its launch identity once, snapshots each call's native tool-use ID before connection waits, and keeps the same identity on reconnect. It cannot ask the wire server for the current grant or reload a mutable current credential. Old tokens and old connections fail after the grant closes; supplying a newer epoch with an old token does not upgrade it.

Epoch checks alone are insufficient. The host retains the exact UUID sent in each native user frame. A native `user_message_uuid` stamp on the first root assistant (including thinking) or partial frame must bind the reply to that send before a root tool call can receive a `claude_goal_origin` attestation. Later frames use immutable native response ownership and the attested root-stream boundary; activeMessage or the current grant never supplies missing source evidence. UUID, native session/response, epoch, message ID, native call ID, tool name and arguments must match. An append-only plugin provenance ledger retains seen/closed IDs across reload and display-history truncation; it is separate from native goal storage. Parented/subagent frames, replay frames, previously recorded tool IDs and background turns cannot attest a new call. The MCP metadata must match this independent native output. Tool cards remain records, not an instruction to execute. The proxy and native stream race is bounded: missing evidence fails closed rather than inferring an origin from the current grant.

Calls retain the exact live agent, open-turn boundary, cancellation and task binding. Native guards recheck them after asynchronous approval. They pass through `agents.withInitiator` and the selected native `tools.execute({ calls, agent, signal })` executor, retaining validation, policies, approvals, guards and revision CAS. On unload, the bridge revokes grants and parks activation through public `goals.disarm`; it never edits persistence or changes the durable phase/revision itself.

Only the three goal schemas and their results cross this bridge. The local system prompt and other local schemas are not supplied. Native completion/blocking wrapup context is returned to Claude in the MCP result with its `tool-goal` source, so it can address the user without replaying the last human request. Remote tool cards stay display-only.

## Recovery and troubleshooting

Delivery uses the existing durable remote message receipts. Retrying the same continuation replays the receipt instead of submitting it twice. A paused/completed/disarmed continuation may replay an existing receipt but gets no new goal tool grant and cannot submit a new message. Restarting the plugin does not recreate grants or arm goals. Within one live grant, repeating the same native tool ID and arguments replays the settled result (including completion/blocking wrapup); changed arguments are rejected. If complete/blocked committed but its reply was lost, retries cannot create another transition. After grant close/reload, the old capability is refused; inspect the native state in a new human turn. Background turns and previous remote responses cannot borrow a later human turn's grant.

A result explicitly naming an old input UUID cannot finish or fail the current turn. A modern opted-in success result without a provable input UUID cannot claim completion. A session-level error without a UUID is instead surfaced as a conservative failure: the current grant is revoked, goal activation is disarmed, and automatic continuation stops. Its `errors[]` text is preserved. Ordinary unlisted chats retain normal error handling and their process, including background failure handling. This does not mark the durable goal complete or blocked.

If the goal server is unavailable, check the exact session allowlist, host plugin availability and whether the scoped executor supports direct calls and Claude supplies native tool-use metadata. The next new main-chat turn launches its own proxy; receipt replay never upgrades the old one. A disconnected goal proxy lists no cached tools, and calls fail closed. Goal calls made from Open sessions alone, or a Claude background turn, have no active main-chat grant. Continue through the ordinary DSH main chat. The bridge does not expose filesystem or shell tools on the DSH host.

## Verification for this change

See repository `artifacts/claude-goal/COMPATIBILITY.md` for exact commands and retained outputs. Tests include real installed GoalService/ToolRuntime/AgentRegistry and a full native AgentLoop/GoalRoundDriver driving the adapter with a fake remote backend. Cases cover completion, human steering, Stop, external pause, reload/disarm and the round cap. The actual embedded proxy runs against in-memory transport stubs for delayed-call and reconnect tests; the actual CliSession parser checks controlled native frames. Claude Code 2.1.319 successfully initialized a disposable stdio MCP server and discovered exactly the three real goal schemas; no model request or business operation was sent.

The restricted test environment denied listening on `127.0.0.1` (`EPERM`). Consequently the SSH reverse-forward/socket path and a real model-driven remote create → automatic continuation → completion run were **not verified** here. The Claude protocol probe is **initialization/discovery smoke only**, using a direct stdio harness. It does not validate model-generated calls, the native metadata in a live model run, per-turn process replacement on an SSH host, or end-to-end goal execution. The native metadata key was also inspected in the installed Claude sender implementation. Socket transport has not been retried with elevated permissions or bypassed. No installed/running plugin or global configuration was changed.
