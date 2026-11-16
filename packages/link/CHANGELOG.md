# DSH Link changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

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
