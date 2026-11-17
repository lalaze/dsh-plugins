# DSH Remote Terminals changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

## 0.1.17 — A file button in TUI conversations, for phones

- A TUI conversation has a paperclip button in its bottom-right corner, beside the rendering button. It opens the device's own file picker; what you choose is uploaded and its path goes into the CLI's prompt, as a dropped or pasted file does (an image shows as `[Image #1]`). A phone can neither drag nor paste a file into a terminal, so until now it had no way to give the CLI a picture or a file.
- On a touch screen both bottom-right buttons are larger (32 pixels) and easier to see.
- Ordinary conversations need nothing new: since DSH 0.2.2-rc.3 the composer's **+** menu has **File**, which opens the same picker on a phone.
- Can be upgraded on its own, without a restart; reload the page (on the phone too) to see the button.

## 0.1.16 — Antigravity's token usage in TUI conversations

- Token usage of Antigravity TUI conversations now goes to `dsh-usage-stats`, one record per turn and model, as Claude Code's and Codex's do. Before, it was not counted at all, so the usage panel showed only Antigravity's chat turns.
- Antigravity logs no usage, so the plugin reads the conversation's own database on the machine it runs on (`~/.gemini/antigravity-cli/conversations/`), with `sqlite3`, or with Python's where that command is missing. It fetches only each model call's usage and when each step began, not what was said. The figures match, token for token, what Antigravity reports for the same turns in a chat.
- A turn counts once Antigravity marks the conversation idle: a few seconds after it ends while its terminal is open, otherwise at the next 10-minute read. The first read of a conversation also counts its earlier turns, at the times they ran.
- The layout of that database is Antigravity's own and not published. A later version of Antigravity may change it, and then its TUI usage stops being counted until this plugin is updated.
- Can be upgraded on its own, without a restart.

## 0.1.15 — A TUI that cannot start says why; Antigravity's sign-in on this computer

- When the button that starts a new conversation in the TUI could not start it, it only got a red outline, and the reason was in its tooltip, so the click seemed to do nothing. Now the reason also appears in a card above the button. Press Esc or click elsewhere to close it; clicking the button again tries again.
- When Antigravity is not signed in for a folder on this computer, the message now says to run `agy acp --login` in a terminal on this computer, not over SSH. Run on this computer, Antigravity reads its sign-in from the keychain, and a sign-in made over SSH is a separate one. Before, the message only explained the SSH case.
- Can be upgraded on its own, without a restart. Refresh the DSH page to get the new button.

## 0.1.14 — A TUI's text comes back whole after the GPU does; its history is rebuilt more often

**Text missing from a TUI after coming back to it, mostly on a phone:**

- With WebGL rendering, a TUI could come back with most of its text gone: no ASCII, no rules, and only some Chinese characters, always the same ones, while new text appeared normally. This happened when the browser dropped the graphics context, as Android does to a page left in the background. Every TUI drawn with WebGL shares one set of glyphs, and after the context returned the glyphs drawn before it stayed blank. Now the plugin draws every glyph again for all TUIs once the context comes back.

**A TUI's history keeps one width more often:**

- The copy of Claude Code that prints the history again at a new width was given 1.5 seconds to start, and on a busy machine it can take longer, so the rebuild was skipped. It now waits up to 10 seconds, and if the copy prints nothing it tries once more after the conversation goes quiet.
- In auto mode Claude Code shows notes such as "Allowed by auto mode" under a tool call only in the session that ran it, and a few headers may keep the old width. These rows could stop the screen from being matched against the copy, which also skipped the rebuild. Such rows are now passed over.
- As before, this needs a Claude Code started by the new version: a TUI conversation still running from an earlier version keeps mixing widths until it restarts, for example after archiving the row and restoring it.
- It can be upgraded on its own; no restart is needed. Reload the DSH pages that show TUIs, the phone's too, to get the drawing fix.

## 0.1.13 — TUI conversations on this computer; a TUI's history keeps one width

**TUI conversations in a folder on this computer** (needs Remote Agents 0.2.142 or newer):

- In a new conversation of a folder on this computer (added with **Add workspace › This computer**), select one of this computer's Claude, Codex or Antigravity models and click its icon at the bottom left of the composer, as in a remote workspace. The CLI runs here, without SSH, from a fresh login environment, as over SSH. Before, the icon was offered in remote workspaces only.
- It is kept by the same holder as on a remote machine, so it keeps running while DSH restarts and selecting the row again shows the same process. Titles, the state in the sidebar, token usage, dropped and pasted files and archiving work as in a remote workspace.
- **Remote Claude**, **Remote Codex** and **Remote Antigravity** in the terminal's shell menu now start their CLI here in such a folder, instead of opening the local shell. **Remote workspace** still opens the local shell, and DSH's own terminal is unchanged.
- A terminal holder now starts detached from the terminal that opened it. DSH ends a terminal together with every process started under it, which on this computer would have taken the holder along.

**A TUI's history keeps one width when you switch devices:**

- With Local scrolling on, Claude Code breaks its lines itself, and when the width changes it repaints only the screen. Everything above kept the width it was printed at, so after switching between a phone and a computer the history came out partly narrow and partly wide, and the text where the two met showed twice.
- Now, once the new width has held for a second, the remote machine runs a copy of Claude Code that prints the conversation again at that width, and everything above the screen is replaced with it, about four seconds after the switch in all. The copy is a fork of the session, which saves nothing, and runs without hooks, MCP servers or updates; it ends as soon as it has printed. While Claude Code is working, the history is put in during a pause in its output, or once the turn ends. The screen, and what you are typing there, stay as they are.
- History from before the conversation was last compacted is not printed again, as Claude Code does not show it when it resumes either, and the rebuilt history keeps at most 5000 lines.
- It applies to a Claude Code started by this version, so the DSH needs this version; one already running keeps the old behaviour until it restarts, as after archiving the row and restoring it, which resumes the same session. Every device showing the conversation then sees the rebuilt history.

## 0.1.12 — Antigravity as a TUI conversation

- A remote Antigravity model now offers the TUI too: in a new conversation of a remote workspace, select one and click the blue A at the bottom left of the composer. The conversation's Chat tab becomes the interactive `agy`, started with the model and effort you selected. **Remote Antigravity** joins Remote Claude and Remote Codex in the terminal's shell menu.
- Antigravity cannot be told the ID of a conversation it starts, so the plugin makes the conversation through Antigravity's ACP server first and opens it with `agy --conversation`. It keeps no model with a conversation, so the model and effort go with every launch; a `/model` inside lasts until the CLI starts again.
- The row is titled from Antigravity's own title or `/rename`, then the first message, read from its summary database on the remote machine (with `sqlite3`, or `python3` where that is missing). Its state in the sidebar comes from its screen alone, as it sets no terminal title.
- Antigravity's token usage is not counted, as it keeps its turns in a database of its own rather than a log.
- Over SSH Antigravity needs a sign-in of its own (`agy acp --login` on that machine), as in Remote Agents' chat; without one, starting the TUI says so. The first time it opens a folder it asks whether to trust it; the first choice is yes.
- It can be upgraded on its own; no restart is needed.

## 0.1.11 — TUI conversations no longer appear in other DSH instances

- A TUI conversation stays in the DSH that started it, and is no longer listed on the machine for other DSH instances to show. To use it from another computer or a phone, open that DSH itself, for example its web page. A conversation open on two devices at once still shares one terminal, whose screen follows the device you are using.
- TUI conversations brought over from another DSH earlier stay and still open the same terminal; their titles and archiving no longer follow the other DSH.
- `~/.dsh-remote-agents/tui-v1/` on each machine is no longer used and is not deleted; remove it by hand if you like. A DSH still on 0.1.10 keeps listing its own TUI conversations there, which an upgraded DSH does not read.
- It can be upgraded on its own, whatever the Remote Agents version. Restart DSH after upgrading.

## 0.1.10 — A TUI open on two devices fits the one you turn to, and text no longer comes out too large in device mode

- A TUI conversation open on two devices, such as a computer and a phone, shares one screen with one size: that of the device that typed last. Until you typed on the other one it stayed in the wrong size, so a computer showed the conversation in a narrow column, and a phone a screen laid out for a wide window.
- Now the screen also follows the device you turn to: clicking or tapping into its terminal, coming back to its window or tab, or opening the conversation there makes it that device's size, as does pasting. A focus change within a second of the size changing hands takes nothing, so two windows cannot keep taking it from each other.
- In a browser that emulates the screen's scale, such as Chrome's device mode on a computer, a TUI's text came out over twice its size, and only the lower left part of the screen showed. WebGL drew it at the emulated scale on a canvas sized at the real one. The plugin now notices and draws such a terminal with the page's own rendering, and the rendering menu says why. On a real phone nothing changes.
- Both DSHes sharing a machine need this version for the screen to follow either way: each DSH's own terminal is the one that asks for the screen.

## 0.1.9 — Swiping a terminal and Claude Code's symbols on a phone

- On a phone or tablet a terminal or a TUI conversation could not be scrolled: a swipe did nothing. The terminal DSH uses reads only a mouse wheel and has no touch handling of its own.
- Swiping now scrolls it as a list scrolls on a phone, and a quick swipe carries on and slows down; a tap anywhere stops it. A conversation in Claude Code's classic renderer (Local scrolling, the default) or a shell scrolls its history. A program that draws the whole screen itself, such as fullscreen Claude Code, gets what a wheel would send it. A tap still opens the keyboard, a swipe does not. Sideways swipes are left to the page.
- On a phone Claude Code's ⏺ before each step showed as an orange emoji tile, and ⏵⏵ before its mode (and similar symbols) as empty boxes: a phone has no text font with them. The plugin now carries those symbols, one terminal cell wide, made from the Noto Sans Symbols 2 font (6 KB). Touch devices only; on a desktop nothing changes.
- Conversations already open on the phone show the symbols after the page reloads.

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
