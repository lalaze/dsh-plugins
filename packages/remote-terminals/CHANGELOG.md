# DSH Remote Terminals changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

## 0.1.8 — Typing in a terminal on a phone or tablet

- On a touch device with a phone layout plugin (dsh-web-mobile), tapping a terminal or a TUI conversation did not let you type: the on-screen keyboard did not come up, and a hardware keyboard typed nowhere.
- Cause: a tap landed on one of the terminal screen's drawing layers, and the terminal then moved keyboard focus to its hidden input from code. That plugin lets code focus a text input only when the finger went down on the input or on an element that contains it, so focus was refused every time.
- On a device whose main pointer is a finger, those layers no longer take the tap, so it lands on the screen itself, which contains the input. Sidebar terminals and TUI conversations both get this; with a mouse nothing changes.
- Opening a TUI conversation on such a device still does not raise the keyboard by itself, which is what that plugin is for: tap the terminal first.
- Nothing to do after upgrading but reload the page. Remote Agents stays as it is.

## 0.1.7 — A TUI conversation appears in every DSH that uses its machine

- A TUI conversation was known only to the DSH that started it. Started on one computer, it was missing from DSH's web page, the phone and every other DSH, although its CLI ran on a machine all of them reach.
- It now appears in each of them within about half a minute, in the remote workspace of its directory (added if missing). All of them open the one terminal on the machine: the same screen everywhere, and any of them can type. The screen has one size: that of the window that opened or resized it last, and typing in another window makes it that window's size again, so it is laid out for whoever is using it. This needs a terminal started by this version; one already running keeps the size of whoever came last until it is started again.
- The title its CLI gives it follows to the other DSHes, unless you renamed it there. Archiving or restoring it in one DSH does the same in the others. Archiving ends its CLI, as before.
- Conversations you archived earlier stay where they are; only ones not archived are listed. Each DSH counts a conversation's usage from when it first showed it, so earlier turns are not counted a second time there.
- A machine with **Share sessions and workspaces with other DSH instances** switched off in Remote Agents keeps its TUI conversations to the DSH that started them.
- After upgrading: install this version in every DSH and restart each. The TUI conversations you have open now are listed by the DSH that started them once it runs this version. Remote Agents stays as it is.

## 0.1.6 — "Connecting…" no longer flashes when you come back to a conversation

- DSH does not keep a sidebar terminal's screen while another conversation is in view. Each time you came back it connected again, and for a moment a row saying **Connecting…** appeared above the terminal, pushed the screen down, and went away.
- That row, and the ones for reading the environment and starting, now show only if they last longer than 0.7 seconds, and take no room until then. The cursor is hidden while the terminal is not connected yet.
- States that need you are shown at once as before: **Reconnect**, **Retry**, **New terminal**, **Take control**.
- The terminal is still built again on each return, so its scroll position is not kept. Local terminals and TUI conversations get the same change.
- Nothing to do after upgrading but restart DSH. Remote Agents stays as it is.

## 0.1.5 — Terminals work on DSH 0.2.2-rc.2

- DSH 0.2.2-rc.2 changed how it starts a terminal. With 0.1.4 installed there, a terminal failed to open with "Cannot read properties of undefined (reading 'throwIfAborted')": TUI conversations, and by the same path the sidebar's terminals, local ones included.
- Terminals start again on 0.2.2-rc.2, keep running after DSH closes, and a terminal saved by an older version still finds its launcher. Earlier DSH versions work as before.
- Upgrade this plugin before DSH, then restart DSH. Remote Agents stays as it is.

## 0.1.4 — Other plugins can type at a TUI conversation's prompt

- A TUI conversation has a terminal where a chat has its input, and DSH keeps the chat input hidden underneath. A plugin that put text into the chat input, such as Game Assets' **Ask the agent…**, wrote into that hidden input, so nothing appeared.
- Such text is now typed at the CLI's prompt as a paste, and is not sent. It waits up to 10 seconds for the terminal if the conversation is on another tab or still opening.
- Claude Code and Codex take a paste with its line breaks. For an app in the terminal that does not, the text goes on one line, so that no part of it is sent.
- The other plugin has to ask for it: Game Assets does from 0.1.3. Restart DSH after upgrading. Remote Agents 0.2.130 stays as it is.

## 0.1.3 — No scrollbar in TUI conversations

- A TUI conversation showed a grey scrollbar on its right edge whenever it scrolled or the pointer came near. It is gone; the wheel and the trackpad scroll as before.
- The text also takes the strip the scrollbar used, and stays centered.
- Nothing to do after upgrading but restart DSH. Remote Agents 0.2.130 stays as it is.

## 0.1.2 — Terminals opened before the upgrade start again

- A sidebar terminal that was open in a remote workspace before the upgrade showed **Selected shell is not available in this execution environment** after DSH restarted, and **Retry** gave the same. The browser remembers the full path of the shell it started, and that path was still the one in Remote Agents' folder, which DSH no longer offers.
- Such a terminal now starts the same shell where it is today, and shows what was running in it, as that kept running on the machine.
- After upgrading, restart DSH and press **Retry** in a terminal that shows the error. Remote Agents 0.2.130 stays as it is.

## 0.1.1 — What Remote Agents refuses is understood again

- Each plugin has its own copy of the code they share, and 0.1.0 did not recognize the errors Remote Agents answers with. A file that is not on the machine, such as a project without `.dsh/worktree.json` on an SSH machine, then counted as a failure instead of as absent, and every refusal from Remote Agents reached the page as error 502 instead of its own status.
- Seen on a real install: asking for the remote shell of a conversation outside a remote workspace answered 502. It now answers that there is none.
- Nothing to do after upgrading but restart DSH. Remote Agents 0.2.130 stays as it is.

## 0.1.0 — Terminals, TUI conversations and worktree workspaces in a plugin of their own

- Remote terminals that outlive DSH, **Remote Claude** and **Remote Codex** in the terminal's shell menu, TUI conversations and **Add workspace › From a project** were part of Remote Agents until 0.2.129. They are this plugin now, and work as before.
- **After upgrading Remote Agents to 0.2.130, install this plugin beside it and restart DSH**, on every DSH that used these features. Without it those features are missing; nothing else in Remote Agents changes.
- Your TUI conversations are taken over on the first start. Terminals and CLIs running on the remote machines keep running, and reopening a conversation shows the same process.
- The plugin keeps no machines of its own: it works on those saved in Remote Agents, through that plugin's connections. Without Remote Agents 0.2.130 or newer it loads and does nothing.
- Other plugins find worktree workspaces under the same service name, `remoteAgentsWorktrees`.
