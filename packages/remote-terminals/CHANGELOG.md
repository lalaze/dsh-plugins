# DSH Remote Terminals changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

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
