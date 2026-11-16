# Machines changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

## 0.1.0 — Open your other computers' DSH from the sidebar

- A switcher in the sidebar foot opens the complete DSH of the same Tailscale account's other computers that run this plugin, in place, and goes back to this computer.
- Approvals and questions waiting on another machine show as a badge on the switcher and as system notifications; finished and failed turns can notify too (Settings → Machines).
- In the desktop app, files dropped, pasted or picked on another machine's page are uploaded to it instead of being referenced by their path on this computer; folders are refused with a note.
- Restart DSH on the machine you are looking at, now or once running work finishes; the page reconnects by itself. Works for a launchd job, the macOS desktop app and `dsh web` from a shell.
- Install it on every computer and restart DSH there. Each opens port 7390 on its Tailscale address, for its own Tailscale user only.
