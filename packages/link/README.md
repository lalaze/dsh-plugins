# DSH Link

**English** | [简体中文](README.zh-CN.md)

Open the complete DSH of your other computers from the one in front of you. Install the plugin in the DSH of every computer on the same Tailscale account; each finds the others, and a switcher in the sidebar foot opens any of them in place: its conversations, approvals, models, settings, files and terminals, as if you sat at it.

- **One switcher.** The sidebar foot shows which machine this page is, with a dot: green ready, amber something waits for you, spinning a turn runs, red unreachable, grey offline. The menu lists every machine with what waits, runs or finished there; a computer where DSH or this plugin was removed leaves the list after ten minutes. Under the machines, **Reload page** and **Restart DSH…** act on the machine you are looking at.
- **Instant switching.** A machine's page stays open in the window once you went there, so going back and forth is instant and keeps where you were. On a wide screen the other machines' pages also open in the background a few seconds after start, so the first switch is instant too. Turn it off in Settings → DSH Link.
- **What happens elsewhere.** A turn that finished or failed, an approval or a question on another machine shows as a notice in the page (click it to go there) and as a badge on the switcher; a system notification follows while the page is not in front. This includes TUI conversations (Claude Code or Codex in a terminal, from remote-terminals). Choose what to be told about in Settings → DSH Link.
- **Safe restart.** Restart DSH on the machine you are looking at, even through another machine: **Restart now**, or **Restart when idle** once running conversations and jobs finish. DSH quits cleanly, a helper starts it again, and the page reconnects by itself. Supported for a launchd job (the Mac mini hub), the macOS desktop app, and `dsh web` started from a shell.

- **Usage of every machine.** With Usage statistics 0.1.20 or later, today's token total in the conversation header and the statistics window add up every machine (see that plugin's README).
- **Browser on other machines (desktop app).** Another machine's page gets DSH's **Browser** panel in the right sidebar, the desktop app's own browser. Addresses of that machine (`localhost`, its private network, `.local` names, its tailnet names) load over that machine's network, so `http://localhost:5173` is the development server running there; the address bar shows them as they are. Public sites load from the computer in front of you.

## How it works

Every DSH with the plugin opens a port (7390 by default) on its own Tailscale address. That listener admits a request only when `tailscale whois` says it comes from the same Tailscale user as the machine itself, and only under the machine's own name (no other site's page can drive it). It then forwards into that machine's DSH with a login made inside the process; no token or password is stored or sent anywhere.

The DSH you are using shows another machine at `/dsh-link/peer/<id>/` on its own address, behind its own sign-in, by forwarding to that machine's listener. Each machine's page keeps its own browser storage. A machine opened through another cannot open a third one.

Nothing goes through a server outside your tailnet.

The Browser panel: DSH mounts its browser only in the desktop app's own profile, and Electron makes its webview tag only in the window's main frame, so a machine's page in the window's frame has neither. The machine's listener adds DSH's browser panel, read from that machine's DSH install, to the pages it serves to other machines (never to its own pages or the phone). The window's DSH Link lends that page the desktop app's browser and creates the page's webviews in the window. An address of the machine is loaded from a name like `p5173.x-http.localhost.<machine id>.localhost:7389` on this computer's loopback. Chromium sends every `*.localhost` name to loopback without asking DNS or a proxy, and treats it as a secure context. The forwarding port passes the request to the machine's listener, which fetches it over the machine's own network: with the site's own `Host`, `Origin` and `Referer`, and with cookies. On the way back, redirects, CORS, CSP and absolute loopback URLs in pages and scripts (`http://localhost:3000`, `ws://127.0.0.1:24678`) are pointed at those names, and cookies are shared across the hostname's ports as they are on the machine. An https address that a plain-HTTP server answers (DSH's address bar turns `localhost:5173` into https) is sent to its http address.

Other plugins on this DSH can reach the machines through the `dshLink` service (version 1): the machine list, and a GET into a machine's DSH through its listener, signed in by that machine's own login. Usage statistics uses it.

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
| `frameBrowser` | on | The Browser panel on other machines' pages, and forwarding their addresses |
| `browserPort` | `7389` | Loopback port the Browser panel loads other machines' addresses from (the next free one up to +10 if taken; the port used is kept) |

`allowSelf` and `listenHost` are for running two DSH instances on one computer in tests.

## Limits

- Anyone signed in to your Tailscale account has full control of every DSH running this plugin.
- In the desktop app, files dropped, pasted or picked on another machine's page are uploaded to that machine (DSH would otherwise name their path on this computer). Folders cannot be sent that way and are refused with a note.
- Plugins on another machine's page talk to that machine: their requests by absolute path (`fetch('/api/…')`, XMLHttpRequest, EventSource, beacons) are sent through its mount. Plugin WebSockets other than DSH's own stream, and images or scripts a plugin loads by absolute path, still come from this computer.
- Phones get no notifications while the page is closed.
- Over a plain `http://` address (HTTP/1.1) pages are not kept unless turned on in Settings: a browser opens only six connections to one host, and two DSH pages fill them.
- Every machine kept open uses memory like another browser tab; closing the window or turning off **Keep machines' pages open** frees it.
- A TUI conversation's turn is known only from its terminal: a stopped or failed one shows as finished, and its approvals do not show as waiting on the board.
- Both computers need this version: the page you switch from keeps the others, and the page of the machine you switch to does its own switching. An older version on the other machine still works, with a reload whenever you switch away from it.
- Windows and systemd services cannot be restarted from the page.
- The Browser panel on another machine's page needs the desktop app, and DSH Link 0.1.12 or later on both computers. A browser or a phone showing another machine gets no panel there.
- The forwarding port listens on loopback only and answers only those names. A request from another site is refused unless that site is such a name too, so a web page open on this computer cannot use it. Anyone signed in to your Tailscale account can already reach every machine's network through its listener.
- A page loaded this way sees its own address as the long `*.localhost` name: code that checks `location.hostname === 'localhost'` sees something else, and cookies a page script sets stay with that port (cookies the server sets are shared across ports).
- A link that the page builds in script to another address of the machine is first tried on this computer, then loaded from the machine.
- The browser on another machine's page cannot open this computer's own `localhost`; use this computer's own page for that.
- The panel there is DSH's own, changed in three places to use the window's browser. If a DSH update changes those places, the panel stays off on that machine and DSH's log says why.

Restart logs: `$DSH_HOME/storages/dsh-link/restart/restart.log`.

The idea and the desktop-window handshake follow [Kivotos](https://github.com/dsh-labs/kivotos) (Apache-2.0); see THIRD_PARTY_NOTICES.md.
