# DSH Link

**English** | [简体中文](README.zh-CN.md)

Open the complete DSH of your other computers from the one in front of you. Install the plugin in the DSH of every computer on the same Tailscale account; each finds the others, and a switcher in the sidebar foot opens any of them in place: its conversations, approvals, models, settings, files and terminals, as if you sat at it.

- **One switcher.** The sidebar foot shows which machine this page is, with a dot: green ready, amber something waits for you, spinning a turn runs, red unreachable, grey offline. The menu lists every machine with what waits, runs or finished there.
- **What waits elsewhere.** Approvals and questions waiting on another machine show as a badge on the switcher, and as system notifications (also for finished and failed turns; choose in Settings → DSH Link).
- **Safe restart.** Restart DSH on the machine you are looking at, even through another machine: **Restart now**, or **Restart when idle** once running conversations and jobs finish. DSH quits cleanly, a helper starts it again, and the page reconnects by itself. Supported for a launchd job (the Mac mini hub), the macOS desktop app, and `dsh web` started from a shell.

## How it works

Every DSH with the plugin opens a port (7390 by default) on its own Tailscale address. That listener admits a request only when `tailscale whois` says it comes from the same Tailscale user as the machine itself, and only under the machine's own name (no other site's page can drive it). It then forwards into that machine's DSH with a login made inside the process; no token or password is stored or sent anywhere.

The DSH you are using shows another machine at `/dsh-link/peer/<id>/` on its own address, behind its own sign-in, by forwarding to that machine's listener. Each machine's page keeps its own browser storage. A machine opened through another cannot open a third one.

Nothing goes through a server outside your tailnet.

## Setup

1. Install **DSH Link** on every computer (Plugins → market, or a `.tgz`) and restart DSH there.
2. The other computers of the same Tailscale account that run the plugin appear in the switcher within half a minute.

Settings (Plugins → DSH Link):

| Setting | Default | |
| --- | --- | --- |
| `name` | Tailscale machine name | How other machines show this one |
| `port` | `7390` | Must be the same on every machine for discovery |
| `listen` | on | Let other machines open this DSH |
| `discover` | on | Find the same account's computers in `tailscale status` |
| `peers` | none | Machines added by address, e.g. `http://100.96.195.115:7390` |
| `tailscale` | found | Path of the `tailscale` command (the macOS app ships it in its bundle) |
| `refreshSeconds` | `30` | How often other machines are checked |

`allowSelf` and `listenHost` are for running two DSH instances on one computer in tests.

## Limits

- Anyone signed in to your Tailscale account has full control of every DSH running this plugin.
- In the desktop app, files dropped, pasted or picked on another machine's page are uploaded to that machine (DSH would otherwise name their path on this computer). Folders cannot be sent that way and are refused with a note.
- Phones get no notifications while the page is closed.
- Windows and systemd services cannot be restarted from the page.

Restart logs: `$DSH_HOME/storages/dsh-link/restart/restart.log`.

The idea and the desktop-window handshake follow [Kivotos](https://github.com/dsh-labs/kivotos) (Apache-2.0); see THIRD_PARTY_NOTICES.md.
