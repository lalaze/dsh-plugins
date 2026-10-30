# DSH Remote Agents changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

What changed in each version and what to do after upgrading, newest first.

**Upgrading from 0.2.63:** The `remoteAgentsWorkspaces` service also lists a remote workspace folder and deletes a file read at a given revision, for the Git panel of `dsh-git-view` 0.2.0: its file browser, its file sizes and times, and discarding untracked files in remote workspaces. Nothing else changes. Restart DSH after updating.

**Upgrading from 0.2.62:** Files dragged, picked or pasted into a remote CLI conversation reach the remote CLI. DSH Desktop sends a non-image file as an `@path` reference to the file on your computer rather than uploading it, so the remote CLI was given a path that does not exist on its machine. Each referenced file that exists on the DSH machine is now uploaded to the remote workspace with the message, and the message points at the uploaded copy; references to paths in the remote workspace are left alone. Folders are still sent as paths. Clicking such a file reference opens DSH's own preview of the file on your computer instead of failing with “Path is outside the remote workspace”. Restart DSH and refresh the client after updating.

**0.2.62 — Git workspace integration:** Adds the versioned `remoteAgentsWorkspaces` service used by `dsh-git-view`: bounded Git batches, cancellation and revision-checked file transfers on the verified SSH target. Requests reject a switched target; cancellation remains bound to the original active session/job, even if its conversation changes workspace. Remote file rows expose stable markers for Git status decorations. Install this release together with Git view for remote repositories; restart DSH and refresh the client. Existing remote workspaces and credentials need no migration.

**Upgrading from 0.2.60:** A remote file's tab is the file alone, edge to edge, as an editor in VS Code. One title bar shows the machine and path, a dot for unsaved edits, and icon buttons to preview Markdown and SVG files, save, discard changes, rename, download and delete; the row of buttons under the editor and the **Edit / Preview** switch above it are gone. **Rename** edits the path in the title bar: Enter renames, Escape cancels. In narrow sidebars the editor now fills the tab's height instead of stopping at a fixed height. Task lists in Markdown previews show their checkboxes beside the items. Refresh the client after updating.

**Upgrading from 0.2.59:** Remote workspace files open in VS Code's editor, Monaco, instead of the previous code editor: a minimap, find and replace, multiple cursors, word-based suggestions, the command palette (F1), ⌥/Alt+Z to toggle word wrap, JSON error checking, and a status bar with the cursor position, indentation, line endings and language. Its menus follow DSH's language. The editor loads from the plugin the first time a file opens, which makes the client itself smaller. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.58:** Images in remote workspace files load instead of failing with `Unexpected end of JSON input`, and **Download** works again. DSH could not hand a download request to the plugin's upload route, so neither had worked in DSH since the remote workspace panel arrived; downloads now have their own route. A transfer that fails before reaching the plugin reports its HTTP status. In the right sidebar's **Workspace files**, a file opens in a tab of its own beside the list, as in DSH's own file browser, instead of under the list; such a tab, like a file link from the conversation, shows only that file and opens at the linked line. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.57:** Remote workspace files open in a code editor with syntax highlighting, line numbers, search (⌘/Ctrl+F) and bracket matching, instead of a plain text box. Images show as pictures instead of a note that the file is binary; click one to switch between fitting the pane and its actual size. Markdown and SVG files have an **Edit / Preview** switch. Files saved with CRLF line endings keep them, which the text box did not. For local workspaces, the new `dsh-file-editor` plugin offers the same editor. Refresh the client after updating.

**Upgrading from 0.2.56:** Folding provider groups in the model menu moved to its own plugin, `dsh-model-groups`; install it to keep folding. Choices you saved carry over, and while an older Remote Agents still folds the groups itself, `dsh-model-groups` leaves them to it. A local tunnel's **Open** link and **Start remote DSH** now use the address your browser reaches DSH at instead of an address built into the plugin. A managed remote DSH started earlier still trusts the old address; if it refuses the new one, stop the managed instance and start it again. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.52:** **Import machines from dsh-remote** is removed from Settings; add machines with **Add host**. Workspaces created by dsh-remote keep working. Machine cards are shorter: the sharing explanation is a hover hint, and **Apply selection** appears only after you change a CLI. Refresh the client after updating.

**Upgrading from 0.2.50:** Sessions and remote workspaces are shared with every DSH connected to the same SSH account; see [Sessions shared between DSH instances](#sessions-shared-between-dsh-instances). After updating and restarting DSH, existing sessions are published to their machine with their history the first time DSH connects to it. To keep a machine's sessions to this DSH, turn sharing off in its card.

**Upgrading from 0.2.41:** Claude Code turns are recorded in usage statistics under the model that answered, so a model chosen by its alias, such as `opus`, appears as its full model ID, such as `claude-opus-5-5`, under **By model**. Turns recorded earlier keep the alias. Restart DSH after updating.

**Upgrading from 0.2.40:** In the **Remote workspace** window opened from Settings, Escape in the file search box clears the search instead of closing the window.

**Upgrading from 0.2.39:** The **Commands** tab is gone from the remote workspace panel; use **New terminal**, which opens the remote shell in a remote conversation. In a remote conversation, **Remote workspace** in the sidebar now holds sync, tunnels and remote DSH, while **Workspace files** holds the files. The file editor saves with ⌘/Ctrl+S, can be closed, opens new files right away and lets you browse folders with unsaved edits. **Add and start** starts a new tunnel, and **Start remote DSH** connects in the same step. In a narrow panel the file list fills the space until a file is open.

**Upgrading from 0.2.38:** Quitting DSH or reloading the plugin while a remote model is answering no longer marks the response **failed** with `The operation was aborted`. The response ends with a note that the remote CLI is still working. When you open the conversation again, it catches up by itself: a **Remote CLI output produced while DSH was disconnected** notice is followed by the output produced meanwhile, and the response follows the remote turn until it finishes. Nothing is sent to the remote CLI again. Responses cut off before this update still show as failed; they catch up the same way. Restart DSH after updating.

**Upgrading from 0.2.37:** In a remote conversation, **New terminal** and its shortcut now open an SSH terminal in the remote workspace instead of your local shell, without choosing **Remote workspace** from the shell menu. Back in a local conversation they open the shell you used before. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.36:** **New terminal** remembers the shell you last chose in every conversation, so after you choose **Remote workspace** once, local conversations used to fail with `Select a verified remote workspace before using this shell.` Outside a remote workspace that shell now opens your local shell instead and says so on its first line; the tab is still titled **Remote workspace**. Restart DSH after updating.

**Upgrading from 0.2.35:** Remote workspace files, search, sync and commands no longer need Node.js on the SSH host. They run with its shell and standard tools, plus `sha256sum`, `shasum` or `openssl`, so a host without Node.js, such as a Docker host with a standalone Codex, no longer fails with `node: not found`. The `remote_workspace` tool for DSH models now follows the conversation's DSH permission: **Full access** and **Auto review** run changes and commands without asking (before, Full access rejected every one), and **Workspace Write** asks only before commands. A command that times out now stops everything it started. Remote CLIs and remote DSH still need Node.js 18+. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.34:** The **Remote workspace** panel has a new layout: tabs for its tools, cards with consistent controls, a tunnel list with status dots and icon actions, and a file browser with icons and a clickable path. Its features are unchanged. Refresh the client after updating.

**Upgrading from 0.2.33:** Codex Fast is now a lightning button in the composer toolbar instead of a separate **Fast** entry in the model menu. It is saved per conversation; new conversations start with it off. A conversation still on an old **Fast** entry moves to the model's entry with the lightning on. Each remote model also remembers the reasoning effort its last message used, so the effort survives switching models and restarts. Refresh the client after updating.

**Upgrading from 0.2.32:** The context usage ring sits closer to the model picker. Refresh the client after updating.

**Upgrading from 0.2.31:** Codex has a new **Workspace write · auto review** mode, and DSH's **Auto** permission now selects it: Codex's reviewer subagent approves or denies requests to leave the sandbox instead of asking you. Remote Codex releases without auto review ignore the setting and keep asking you. Saved Codex catalogs gain the mode without a refresh.

**Upgrading from 0.2.30:** Model menu group headings are now as tall as the model rows, with a chevron that turns when a group opens, a count pill and a hover highlight. The Codex subscription menu places itself again after a group folds or unfolds. Refresh the client after updating.

**Upgrading from 0.2.29:** Images that a remote CLI references by workspace path now show in native chat replies. Each image is copied to the DSH host under the plugin's state directory (`chat-images/`). Replies saved before the update still show alt text.

**Upgrading from 0.2.28:** Provider groups fold again when the Codex subscription plugin (`dsh-codex-subscription`) replaces the model menu. That menu shows no provider ids, so its groups remember their folding by provider name. Refresh the client after updating.

**Upgrading from 0.2.27:** In a conversation on a remote workspace, the right sidebar's **Workspace files** and ⌘P open the remote files, and **Remote workspace** is listed there only in remote conversations. Local conversations keep DSH's own Workspace files. Refresh the client after updating.

**Upgrading from 0.2.26:** Adds the integrated **Remote workspace** panel (files, commands, sync, tunnels and remote DSH) and a `remote_workspace` tool for DSH models; see [Integrated workspace tools](#integrated-workspace-tools). Machines saved in dsh-remote can be imported from **Settings → Remote agents**. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.25:** Provider groups in the model menu fold again in DSH builds whose model rows carry no model ids, such as the Desktop app: those groups remember their folding by provider name. Groups that already folded keep their saved choices. Refresh the client after updating.

**Upgrading from 0.2.24:** A conversation whose remote CLI failed to start (for example, because the SSH host had no Node.js) no longer stays stuck with "This agent is still working" after the host is fixed: the next message starts the CLI with that message, keeping earlier messages as context. Restart DSH after updating.

**Upgrading from 0.2.23:** A remote CLI is no longer started when its SSH host cannot run the background relay (no Node.js 18+ on the login PATH, or the relay cannot be installed); the response fails with the reason instead of silently using a direct SSH pipe that ends with DSH. Install Node.js 18 or newer on such hosts. New conversations are titled from your first message instead of DSH's title instruction; existing titles are not changed. Restart DSH after updating.

**Upgrading from 0.2.22:** Claude and Codex in the main chat now follow the conversation's DSH permission (the composer or `/permission`) instead of always using the remote CLI's own settings: Workspace Write runs Claude in Accept edits, Full access runs without approval prompts, and Auto review runs Claude in Auto. The DSH permission overrides a mode chosen in Open sessions from the next message. Restart DSH after updating.

**Upgrading from 0.2.21:** Every turn's usage, main chat included, now reaches `dsh-usage-stats` through the `remote-agents/usage` event with the machine name and remote directory, so usage can be broken down by host and workspace. Main chat no longer reports a turn's total to DSH as model usage, because it spans many model calls and would misstate the conversation's context size. Update `dsh-usage-stats` to 0.1.5 together with this version, or main-chat turns are counted twice. Restart DSH after updating.

**Upgrading from 0.2.20:** Each finished turn now records the tokens it used (Claude Code, Codex, and ACP CLIs that report usage). With `dsh-usage-stats` 0.1.3 or later, they appear under **Remote agents** in **Settings → Usage statistics**: main-chat turns through their DSH model call, delegated agents and turns sent from **Open sessions** through a `remote-agents/usage` event. Turns from before the update are not imported. Restart DSH after updating.

**Upgrading from 0.2.19:** **Add workspace** gains a **Remote machine** tab that adds a saved machine's directory as a DSH workspace. Codex now also offers **Remote CLI settings**, which leaves approval policy and sandbox to `~/.codex/config.toml` on the remote machine. New main-chat conversations and agents DSH starts without an explicit mode use it for both Claude and Codex. Existing sessions keep their saved mode. Restart DSH and click **Refresh models** beside each machine after updating.

**Upgrading from 0.2.18:** Remote CLIs now keep running when DSH quits or SSH disconnects, and DSH reconnects and catches up automatically. This needs Node.js 18+ on the SSH host. Restart DSH after updating; sessions created earlier switch to a relay the next time their CLI starts.

**Upgrading from 0.2.17:** Remote sessions use a two-pane reading layout with active/history views, date groups, bulk archiving, Markdown replies and collapsed tool activity. Permission mode and renaming are in the header’s Session options. Existing history and native CLI sessions remain available. Restart DSH and refresh the client after updating.

**Upgrading from 0.2.12:** Adds image and file transfer from the main composer. Restart DSH and refresh the client after updating; refresh host models to pick up each CLI’s declared image capabilities.

**Upgrading from 0.2.11:** Claude now inherits remote permission settings by default. Permission modes and matching session/project approvals are available in **Open sessions**. Existing sessions keep their explicit mode; stop an active session and select **Remote CLI settings** to inherit the remote default.

**Upgrading from 0.2.10:** Fixes `3: Bad file descriptor` when remote login scripts close inherited descriptors, blocking model discovery or CLI startup. Restart DSH after updating, then refresh the host’s models.

**Upgrading from 0.2.9:** Hosts with saved sessions can now be removed after an SSH error. Confirm removal to delete their plugin sessions and saved output without reconnecting.

**Upgrading from 0.2.8:** Remote CLIs now load the remote shell’s interactive login environment. This addresses authentication failures caused by missing shell environment when the same Claude command succeeds in an interactive terminal. Update and restart DSH, refresh the machine’s models, and retry the conversation.

**Upgrading from 0.2.7:** Remote sessions now open only through settings; the sidebar entry has been removed. Update the plugin and refresh the client.

**Upgrading from 0.2.6:** Main-chat models are filtered by the workspace machine and verified again before sending. Existing conversations can continue only when their machine and directory match. Update the server plugin and refresh the client; machines and model caches need no migration.

**Upgrading from 0.2.5:** Fixes provider folding failing to activate on the real DSH client because the previous version redeclared an existing child slot. The native model seat is now preserved. Restart DSH and refresh the client; saved folding preferences still apply.

**Upgrading from 0.2.4:** Provider headings in the composer model menu now expand and collapse. Refresh the client after upgrading; no machine or session migration is needed.

**Upgrading from 0.2.3:** Per-machine CLI selection is now available, and SSH no longer selects an old nvm runtime ahead of a compatible installed Node. Adjust the checkboxes and click **Apply selection**.

**Upgrading from 0.2.2:** Click **Refresh models** beside each machine to populate the machine-wide model menu. Existing project-bound conversations keep their saved working directories; legacy project routes remain resolvable but are hidden from the new picker.

**Upgrading from 0.2.1:** Remote models are grouped directly under their CLI providers and keep the native composer. A unified Remote sessions entry is available in the sidebar. Saved hosts, projects, conversations and output are preserved; the old aggregate route remains resolvable for saved conversations but is not advertised in the model picker.

**Upgrading from 0.2.0:** Main chat is available through the CLI provider groups. Add a host or refresh its models; existing independent agents and saved output are preserved.

**Upgrading from 0.1.x:** The embedded Claude SSH engine remains removed. This plugin now connects Claude Code through the same direct CLI backend as the other providers. The separate `dsh-claude-ssh` plugin and its data are unaffected. Old main-chat project/binding records are not imported; refresh the host model catalog in settings. Hosts, independent agents and their output carry over.
