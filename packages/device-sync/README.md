# DSH Device Sync

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates.

`dsh-device-sync` pairs two DeepSeek Harness machines, such as a laptop and a Mac mini, over Tailscale. They share workspace groups and conversation history, and each can steer the other’s sessions. Records are synced; tasks are never run twice: every session runs only on the machine that owns it, and the other machine keeps a read-only copy.

## What is shared

- **Groups**: the tags of [Workspace Tags](../workspace-tags/README.md) (name and color), and which workspaces have them, on both machines. Edits are merged field by field and reach the other machine within a few seconds. When both machines changed the same field before syncing, the later value is used on both and the other one is kept as a conflict under **Settings → Device sync** until you pick one. Tags created separately under the same name are both kept, the later one renamed “Name (2)”.
- **Workspaces**: each machine’s workspaces, with their stable ID, title, path and order. A path is shown for information only and is never used on the other machine; directories with the same name are not treated as the same project. For a remote workspace of [Remote Agents](../remote-agents/README.md) (or dsh-remote), the SSH directory it stands for is shared too: host, user, port and remote path, read from `.dsh-remote-meta.json` in its folder under `$DSH_HOME/remote-workspaces/`.
- **Conversations**: titles, workspace, archive state, user messages, assistant replies, tool calls and results, fork links, approvals asked and decided. System prompts, request headers and the model’s token stream stay on their machine. Images are stored once by content; small images arrive with their session, larger attachments when first opened.

Copies live in this plugin’s storage, not in DSH’s session store, so nothing synced can start an agent. A session removed on its machine stays readable here.

Not shared: project files, Git working copies, dependencies, environment variables, passwords, API keys, OAuth tokens, browser cookies or SSH keys. A machine steered from the other one uses its own files and its own model sign-ins.

## Steering the other machine

With permission (see below), the host API accepts these requests for the other machine’s sessions, and runs them there:

- send a message, stop the running task;
- answer a tool approval or a question it is waiting for;
- start a session in one of its workspaces, linked to the session it carries on.

Each request carries an ID, so a retry after a lost connection never runs it twice. When the other machine is offline, a request is held and sent only after you confirm it again; it is never run on this machine instead.

Open **Settings → Device sync → Synced sessions** and select a title to read its mirrored timeline, including attachments and live drafts. Sessions are grouped by machine and workspace. Each machine’s card starts folded and shows its session count; each workspace lists its five most recent sessions until you choose **Show more**. Search matches titles, session IDs, workspace names and folders, and unfolds every match. Hidden and subagent sessions are excluded until their filters are enabled. Hide/restore affects only this machine. Archived and deleted sessions remain readable.

While the viewer is open and the peer is online with history sharing allowed, an interrupted live stream reconnects after 3 seconds. Only one stream is active per viewer. Closing/switching the viewer, going offline, revoking history access or deleting the remote session cancels its live stream and retry delay and clears the draft. Permanent HTTP denials such as 403/404 stop retries until the viewer is reopened or eligibility changes. History polling errors and live-stream errors are displayed independently; a successful history fetch does not hide a failed live connection.

**Remote workspaces** lists each paired machine’s workspaces in a folded card. Select a group chip to add a workspace to that group or take it out; the change shows in that machine’s sidebar. Remote paths are never mapped or opened here. **Pending requests** lets you explicitly send or discard held requests and shows delivery failures. A delivered request and a still-held request have different status messages.

The viewer supports text messages (queue by default, or steer), stopping an online task, and answering online approvals/questions when the owning machine grants command access. Non-answerable approvals must be answered on the owning machine. Requests cannot be sent to paused/unpaired machines or archived/deleted sessions from this client. Offline prompts are held; no request is automatically released. Uncertain browser responses retain the original request ID for retry, first checking the outbox, so a lost response cannot create a fresh execution.

The viewer is embedded in settings (also accessible through the existing header badge). Image uploads are not included. Starting a session on the other machine has no control in the viewer; the host API remains available. Existing mirrored image/file attachments can be viewed. No real two-host or authenticated DSH GUI acceptance is claimed by the automated tests.

## Continuing an SSH workspace’s conversation on this machine

A conversation in a remote workspace, driven by a DSH model such as DeepSeek through `remote_workspace`, lives in the DSH of the machine that started it. When that machine is off, the other one can carry it on: the project is on the SSH machine, not on either DSH machine.

Two workspaces are the same project when they are the same SSH directory: the same host, user, port and remote path (host names compare without case or a trailing dot; paths after resolving `.` and `..`). Folder names and titles do not count.

The viewer of a synced conversation in such a workspace offers **Continue on this machine**:

- When this machine has a workspace for the same directory, it names it and takes an optional note on what should happen next. **Continue here** starts a new conversation in that workspace here, and opens it. Its first message holds the synced history: user messages and assistant replies, the most recent part when it is long, with tool calls reduced to their names and tool results left out; then the note. The original conversation is not changed, and the other machine is not asked. The new conversation records which one it continues. A retry after a lost response reuses the request ID, so it starts at most one conversation.
- When it has none, the viewer says so. Add the SSH machine under **Settings → Remote agents**; Remote Agents then brings in the remote workspaces shared on that machine.
- Conversations outside SSH workspaces do not offer it. Conversations of Remote Agents’ CLI models (Claude, Codex) carry on through Remote Agents’ shared sessions instead.

Both machines need this version: an older one does not share the SSH directory of its workspaces.

## Requirements

- DSH 0.2.1-rc.3 or a later 0.2 release on both machines.
- Tailscale connected on both machines. The plugin listens on this machine’s Tailscale address, port 47630, and by default accepts only Tailscale and loopback addresses.
- [Workspace Tags](../workspace-tags/README.md) 0.1.10 or later, for groups.
- Clocks within 5 minutes of each other.

## Pairing

1. Install the plugin on both machines and restart DSH.
2. On one machine, open **Settings → Device sync**. Under **This machine** it shows its address, for example `100.96.195.115:47630`.
3. On the other machine, enter that address under **Pair a machine**, choose what to allow, and select **Pair**.
4. Both machines now show the same six-digit code. Check that the codes match, then confirm on both machines; pairing completes only once both have confirmed.

Each machine decides what it allows the other:

- **Share history**: its workspaces, groups and conversations. On by default.
- **Allow remote control**: messages, stopping tasks and confirmations in its sessions. Off by default.

Once paired, the conversation header shows the other machine’s name and whether it is online, with a warning dot when syncing fails; select it to open these settings in a window.

Change either at any time under the paired machine’s card, which also shows whether it is online, when it last synced, how many sessions and requests are waiting, the last failure, and **Sync now**, **Pause sync** and **Unpair…**. After unpairing, the other machine can no longer sync or send requests; you can also delete the history copied from it.

Before the first sync with a machine, the plugin backs up its state, the Workspace Tags state and the existing copies under `backups/` in its storage folder, keeping the last 10.

## Security

Each machine has its own Ed25519 device key, created on first start; the device ID is derived from it and the private key never leaves the machine. Every request between machines is signed and names its target device; every answer is signed and tied to that request; repeated requests are refused. The pairing code covers both keys and both random values exchanged, so a machine in the middle would show different codes. Tailscale encrypts the traffic. Pairing uses no browser sign-in link, and unpairing revokes the device key at once.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `47630` | Port paired machines connect to |
| `listenHost` | Tailscale IPv4 | Address to listen on instead |
| `advertise` | `address:port` | Address paired machines use to reach this one, such as a MagicDNS name |
| `anyNetwork` | `false` | Accept paired machines outside Tailscale |
| `stateDir` | `~/.dsh/storages/dsh-device-sync` | Storage folder (under `DSH_HOME` when set) |

## How it uses DSH

- Sessions are read through DSH’s session controller (`list`, `inspect` and `follow`), which reads logs without starting agents, and steered through its `prompt` and `cancel`. Questions are answered through DSH’s `userQuestions` service.
- DSH has no interface for answering tool approvals from another host. The plugin joins DSH’s `approval/request` chain on the machine that runs the session: while a paired machine allowed to steer is online, the question goes both to it and to the browsers of this machine, and whichever answers first wins; the other is withdrawn. Any failure leaves DSH’s own chain unchanged.
- Groups go through the `workspaceTags` service of Workspace Tags 0.1.10.

Two small additions to DSH would make this simpler: importing a read-only session, so copies could show in DSH’s own sidebar and conversation view, and an approvals interface for hosts.

Build and install on both machines:

```sh
pnpm --filter dsh-device-sync check
pnpm --filter dsh-device-sync pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-device-sync-0.1.4.tgz"
```

## 0.1.4 release notes

- Remote workspaces: group chips lock with the reason when a change could never reach the other machine (this machine does not share with it, or it is no longer paired); while it is paused or offline, a note says the change arrives later. Such assignments are also refused by the plugin, and conflicts on the removed workspace links are no longer shown.

## 0.1.3 release notes

- Version bump only; same features as 0.1.2.

## 0.1.2 release notes

- Synced sessions can be searched; machine cards fold, and each workspace shows its five most recent sessions until expanded.
- Remote workspaces fold per machine, one row per workspace, with group chips to toggle; linking remote and local workspaces is no longer offered, as nothing used it yet.

## 0.1.1 release notes

- The conversation header shows the paired machine and whether it is online, or that syncing failed; select it to open Device sync settings in a window.

## 0.1.0 release notes

- First release: pairing over Tailscale with codes confirmed on both machines, shared groups, workspaces and conversation history, remote requests with held delivery while offline, and sync status in Settings.
- Not yet tested between two real DSH hosts; tested against a simulated DSH host on one machine.
