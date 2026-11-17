# DSH Link changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

## 0.1.8 — Removed machines leave the list; the menu's actions are icons

Update every computer; no restart needed, reload the page once.

- A computer of your Tailscale account where DSH or this plugin was removed (shown as "Not running this plugin") leaves the machine list once nothing has answered on its port for ten minutes. It comes back by itself if it runs the plugin again. A computer that is asleep or switched off stays, as before.
- The machine menu's **Reload** and **Restart DSH** rows are now two icon buttons in one row under the machines; their tooltips name the machine.

## 0.1.7 — Usage statistics can add up every machine

Update every computer whose page you look at; restart DSH there for the service to load. Other machines need nothing new.

- Other plugins on this DSH can now reach the machines: a `dshLink` service lists them and sends a GET into a machine's DSH through its listener, signed in by that machine's own login, as its page is. Usage statistics 0.1.20 uses it to count every machine's usage in the header and the statistics window.

## 0.1.6 — ⌘R reloads the machine you are looking at

Update the computer whose desktop window shows the other machines; reload the window once. Update the other machines too for the menu item.

- In the desktop app, ⌘R did nothing in another machine's page: the app gives ⌘R to DSH's right sidebar and never reloads its window, and a machine's page in the window is a web page, where nothing handles it. Now ⌘R in another machine's page loads that page again. The window and the other machines' pages stay as they are. Ctrl+R still reaches the page, as terminals use it to search history.
- The machine menu has **Reload {name}**, which loads the page you are on again: in the desktop window only that machine's page. It shows on a machine's page once that machine has this version.

## 0.1.5 — The wallpaper shows behind the desktop title strip

Update the computer whose desktop window shows the other machines; reload the window once. The other machines need nothing.

- In the desktop app, the title strip over another machine's page is see-through. That page now fills the window and starts below the strip, so a Gallery wallpaper (or the page's own background) reaches behind the window buttons and the machine name, as on this computer's own page. Its menus and dialogs keep clear of the strip, and full screen still hides it.

## 0.1.4 — Desktop window fixes, and no stalls over HTTP/1.1

Update every computer; no restart needed, reload the window once.

- In the desktop app, another machine's page no longer draws its logo under the macOS window buttons: a thin title strip over it holds the buttons, moves the window and names the machine shown. Full screen hides it.
- A machine's page that is the window's page (opened by its address, or left there by an earlier version and reloaded) goes to this computer's page and shows the machine there, so switching back and forth stops reloading. A machine opened with **Open directly** stays as it is.
- Over HTTP/1.1 (a plain `http://` address) pages are no longer kept by default: a browser opens only six connections to one host, each DSH page holds about four, and a second page made both stall. Switching then loads the page as before; Settings → DSH Link can still turn keeping on. HTTPS (HTTP/2, such as the phone's address) and the desktop app keep pages as before.
- `/dsh-link/diag` lists what this computer's windows reported about switching (connection, how long another machine's page took), readable through another machine's mount.

## 0.1.3 — A machine Tailscale wrongly calls offline still shows

- A machine this computer already knew is asked anyway when Tailscale calls it offline, and listed online when it answers. Tailscale's flag is its coordination server's view: a computer whose Tailscale lost that server (the MacBook Air on a relay) stayed reachable but showed as offline, so the switcher could not open it and its finished turns and approvals never arrived. Update every computer; no restart needed.

## 0.1.2 — Instant switching, and notices for what happens on other machines

Update every computer and restart DSH there: the page you switch from keeps the others, the page you switch to does its own switching, and each machine tells about its own TUI turns.

- Switching no longer reloads. A machine's page stays open in the window once you went there, so going back and forth is instant and keeps where you were; a reload of the window comes back to the machine it showed. On a wide screen the other machines' pages open in the background a few seconds after start, and opening the switcher starts them on any screen. Settings → DSH Link → Switching turns it off.
- Another machine's finished or failed turns, approvals and questions show as a notice in the page, which takes you there in one click, and finished turns also as a green badge on the switcher. System notifications are now only for while the page is not in front. Phones and the desktop app get the notices without any permission.
- Turns of TUI conversations (Claude Code or Codex in a terminal, from remote-terminals) count: they show as running and as finished. Before, only DSH's own turns did, so a Claude Code turn on the Mac mini never told the MacBook it was done.
- A notice now carries the conversation's title when the title came after the conversation started.

## 0.1.1 — Plugins on another machine's page talk to that machine

- Requests that plugins send by absolute path on another machine's page (`fetch('/api/…')`, XMLHttpRequest, EventSource, beacons) go through its mount, so remote-agents' model picker shows that machine's remote CLIs. Only the computer you switch from needs it.

## 0.1.0 — Open your other computers' DSH from the sidebar

First released earlier the same day as `dsh-machines` 0.1.0 and renamed before anyone else installed it. Where `dsh-machines` is installed, remove it, install DSH Link and restart DSH. The two use the same port (7390) but do not recognise each other, so switch every computer.

- A switcher in the sidebar foot opens the complete DSH of the same Tailscale account's other computers that run this plugin, in place, and goes back to this computer.
- Approvals and questions waiting on another machine show as a badge on the switcher and as system notifications; finished and failed turns can notify too (Settings → DSH Link).
- In the desktop app, files dropped, pasted or picked on another machine's page are uploaded to it instead of being referenced by their path on this computer; folders are refused with a note.
- Restart DSH on the machine you are looking at, now or once running work finishes; the page reconnects by itself. Works for a launchd job, the macOS desktop app and `dsh web` from a shell.
- Install it on every computer and restart DSH there. Each opens port 7390 on its Tailscale address, for its own Tailscale user only.
