# DSH Mobile

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese: the settings page follows DSH’s language setting, the phone app follows the phone’s language.

`dsh-mobile` lets you read and steer your machines’ DeepSeek Harness sessions from your phone, from anywhere, the way Paseo’s app does. The phone connects through a relay, so neither the machine nor the phone needs an open port or a VPN. Everything the phone and the machine exchange is encrypted end to end; the relay only routes bytes it cannot read. Sessions always run on the machine, with its files and sign-ins, including sessions that use remote CLIs from [Remote Agents](../remote-agents/README.md).

## What the phone can do

- **Sessions**: grouped as [Workspace Tags](../workspace-tags/README.md) groups DSH's sidebar by status: **Waiting for you**, **Completed** (finished since you last looked), **Running** and **Idle** (folded). A workspace with a running session goes to Running whole. Workspaces keep their sidebar order and tag dots; sessions keep their workspace's order, five at a time with **Show more**, each with its model's logo. A session waiting for you says what it asks under its title. Tag chips narrow the list to one tag; search sits behind the magnifier, and archived sessions, sub-agents and sessions outside any workspace can be shown from the view options. As in DSH, blank sessions and sessions outside any workspace are hidden by default. Pull the list down to reconnect and reload; long-press a session to rename or archive it. The list keeps its place while a session is open. Pair several machines and their sessions appear together.
- **Conversations**: read from the end; earlier messages load as you scroll up, and a button returns to the newest. Markdown replies with a copy button on code, collapsed reasoning, each turn's duration with a copy button; images open full screen. Each tool call is one line saying what it did and to what (a command, a file, a search), consecutive calls folded into one group; tap one for its details: a command with its output, an edit as a diff, a plan as a checklist. Replies stream in while they are written. Context DSH injects (workspace instructions, skill catalog, time snapshots) stays hidden, as in DSH.
- **Steering**: send a message with images (scaled down on the phone first). Sending while a task runs interrupts it with your message, as in Paseo; with nothing typed, the button stops the task. Under the input, pills show the session's model, reasoning level and permission; change the model or reasoning level from them. Approvals (with the exact command) and questions wait above the input with large buttons. A sent message shows at once; an unsent one is kept per session. Rename and archive sessions from the title. The phone's back gesture closes an open sheet before it leaves the screen.
- **New sessions**: prompt first, as in Paseo: write the task, pick the workspace (recent ones are one tap away) and the model, reasoning level and permission preset from the pills under it. With several machines paired, choose which one runs it.
- **Background tasks**: with [Remote Agents](../remote-agents/README.md) 0.2.67 or later on the machine, its remote CLI sessions that have no DSH conversation, such as tasks DSH's agent delegated and sessions started from **Open sessions**, are listed under **Background tasks**: those waiting for an answer first, then running ones. Open one to read its history and follow it while it runs, send a message (sending while it runs interrupts it), stop it, or answer its approvals. A delegated task links to the conversation that delegated it.
- **Notifications** (optional): when a task finishes or a session needs you, even while the app is closed. A notification for the session already on screen is skipped.

Every request carries an ID, so a retry after a lost connection never runs twice. The app reconnects by itself and catches up on what it missed.

## Requirements

- DSH 0.2.1-rc.3 or a later 0.2 release, on a machine that stays on while you use the phone. Sessions run there.
- A relay speaking Paseo’s relay protocol (v2), such as a self-hosted Paseo relay. The plugin connects to it with its own server ID and can share a relay with a Paseo daemon.
- The phone app hosted over HTTPS (see below).
- For notifications on iPhone: iOS 16.4 or later, with the app added to the Home Screen.

## Setting up

1. Install the plugin and restart DSH.
2. Open **Settings → Phone access** and enter:
   - **Relay**: `host:port`, such as `relay.example.com:443`. TLS is used unless you write `ws://`. The status next to it shows whether the machine is connected. If the relay only accepts server IDs it knows, allow the **Server ID** shown there.
   - **Phone app address**: where the phone app is hosted, such as `https://dsh.example.com/`.
3. Select **Pair a phone**. Scan the code with the phone’s camera (or open the link on the phone). The code works once and expires after 10 minutes.
4. The phone and the settings page show the same six digits. Check them, choose what the phone may do, and select **Allow**.

On iPhone, add the app to the Home Screen (Share → Add to Home Screen) and open it from there before turning on notifications. A Home Screen app keeps its own storage, so pair from inside it: tap **Scan code** in the app or paste the link.

### Hosting the phone app

`pnpm --filter dsh-mobile build` writes the app to `packages/mobile/lib/app/`: static files to put on any HTTPS host (a subpath works). The app only talks to the relay; the host never sees your data.

To try it without hosting, use this DSH’s own address followed by `/api/dsh-mobile/app/index.html` (**Use this DSH** fills it in). That copy only opens in browsers already signed in to this DSH, so it suits a phone on the same Tailscale network, not a phone elsewhere.

## Phones and permissions

Each paired phone is listed with whether it is online, when it was last seen, and whether notifications are on. For each phone:

- **Read sessions**: workspaces, conversations and attachments.
- **Steer sessions**: send messages, stop tasks, answer approvals and questions, start, rename and archive sessions.

Change either at any time; **Unpair** disconnects the phone at once and refuses it afterwards. A phone allowed to steer also receives DSH’s tool approvals while it is online or has notifications on: the question goes to it and to this machine’s browsers, and whichever answers first wins.

## Security

- The pairing code carries the machine’s public key, so the phone knows whom it talks to; a relay or anyone else in the middle cannot pose as the machine.
- Each phone has its own key, created on the phone. The machine accepts only keys it paired, after you confirmed the six digits, which both screens derive from both keys and the one-time token.
- Each connection derives new AES-256-GCM keys from X25519 (static and ephemeral keys) with HKDF-SHA256. Frames are numbered; a dropped, repeated or reordered frame ends the connection.
- Notifications are encrypted for the phone’s browser (Web Push, RFC 8291) and sent straight from the machine to the phone’s push service with a VAPID key of its own.
- The phone stores its key and the paired machines in the app’s local storage. Remove a machine from the phone under **Settings**, and unpair it on the machine too.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `relay` | none | Relay for a new setup; change it later on the settings page |
| `appUrl` | none | Phone app address for a new setup |
| `stateDir` | `~/.dsh/storages/dsh-mobile` | Storage folder (under `DSH_HOME` when set) |

## How it uses DSH

- Sessions are read through DSH’s session controller (`list`, `inspect` and `follow`), which reads logs without starting agents, and steered through its `prompt`, `cancel`, `create`, `selectModel` and `rename`. Archiving goes through the workspace controller, questions through `userQuestions`, permission presets through `permissionPresets`.
- Background tasks come from Remote Agents' `remoteAgentsTasks` service on the same machine; without it the section is not shown.
- DSH has no interface for answering tool approvals from another device. The plugin joins DSH’s `approval/request` chain: the question goes to the phone and to this machine’s browsers, and whichever answers first wins; any failure leaves DSH’s own chain unchanged.

## Limitations

- Notifications work for one paired machine at a time per phone, because a browser holds one push key.
- Background tasks take text only and send no notifications, and their questions are answered on the computer.
- Attachments over 16 MB do not open on the phone.
- An existing session's permission preset is shown but cannot be changed from the phone; DSH changes it only on a running session.

## Acknowledgments

The app uses DeepSeek Harness's icon (from `@deepseek-ai/dsh-web-frontend`, MIT) and model vendor logos from LobeHub (MIT, through dsh-session-models); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```sh
pnpm --filter dsh-mobile check
pnpm --filter dsh-mobile pack:plugin
```

Tests run the real phone client (`app/src/hub-client.ts`) against the plugin through an in-memory relay speaking the same protocol, with a simulated DSH host.
