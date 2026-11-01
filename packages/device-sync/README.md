# DSH Device Sync

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates.

`dsh-device-sync` pairs two DeepSeek Harness machines, such as a laptop and a Mac mini, over Tailscale. They share workspace groups and conversation history, and each can steer the other’s sessions. Records are synced; tasks are never run twice: every session runs only on the machine that owns it, and the other machine keeps a read-only copy.

## What is shared

- **Groups**: the tags of [Workspace Tags](../workspace-tags/README.md) (name and color), and which workspaces have them, on both machines. Edits are merged field by field and reach the other machine within a few seconds. When both machines changed the same field before syncing, the later value is used on both and the other one is kept as a conflict under **Settings → Device sync** until you pick one. Tags created separately under the same name are both kept, the later one renamed “Name (2)”.
- **Workspaces**: each machine’s workspaces, with their stable ID, title, path and order. A path is shown for information only and is never used on the other machine; directories with the same name are not treated as the same project.
- **Conversations**: titles, workspace, archive state, user messages, assistant replies, tool calls and results, fork links, approvals asked and decided. System prompts, request headers and the model’s token stream stay on their machine. Images are stored once by content; small images arrive with their session, larger attachments when first opened.

Copies live in this plugin’s storage, not in DSH’s session store, so nothing synced can start an agent. A session removed on its machine stays readable here.

Not shared: project files, Git working copies, dependencies, environment variables, passwords, API keys, OAuth tokens, browser cookies or SSH keys. A machine steered from the other one uses its own files and its own model sign-ins.

## Steering the other machine

With permission (see below), the host API accepts these requests for the other machine’s sessions, and runs them there:

- send a message, stop the running task;
- answer a tool approval or a question it is waiting for;
- start a session in one of its workspaces, linked to the session it carries on.

Each request carries an ID, so a retry after a lost connection never runs it twice. When the other machine is offline, a request is held and sent only after you confirm it again; it is never run on this machine instead.

This version has no window of its own for reading and steering the other machine’s sessions. Open the other machine’s DSH Web over Tailscale to watch and steer them; a phone works the same way. While it is offline, its synced history stays on this machine.

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
dsh plugin --profile web add "$PWD/dist/dsh-device-sync-0.1.0.tgz"
```

## 0.1.0 release notes

- First release: pairing over Tailscale with codes confirmed on both machines, shared groups, workspaces and conversation history, remote requests with held delivery while offline, and sync status in Settings.
- Not yet tested between two real DSH hosts; tested against a simulated DSH host on one machine.
