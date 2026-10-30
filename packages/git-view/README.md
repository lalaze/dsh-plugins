# Git View

**English** | [简体中文](README.zh-CN.md)

An IDE-style Git panel for DeepSeek Harness conversations, ported from [`@xbzbing/dsh-git-panel`](https://github.com/xbzbing/dsh-git-panel) 1.10.0: the **Git overview** of branches, tags and the commit graph, **Changes** with commit and amend, and a **File browser**, plus Monaco diffs of changed files and change marks in file lists. It works in local workspaces and, unlike dsh-git-panel, in Remote Agents workspaces on their SSH host. Package: `dsh-git-view`.

## Requirements and installation

- DSH `>=0.2.1-rc.2 <0.3.0`, with the right-sidebar and conversation UI services; Node.js ≥ 22.15.0.
- Git on the machine that holds the repository. On macOS, Apple's `/usr/bin/git` requires the Xcode Command Line Tools (`xcode-select --install`).
- **Remote workspaces require `dsh-remote-agents` 0.2.62 or newer**, exposing Git workspace API version 1; the panel's file browser, its file sizes and times, and removing untracked files there need **0.2.64**. Install both plugins into the same DSH profile. Earlier releases and unversioned experimental Git services fail closed instead of silently ignoring workspace binding. Local workspaces do not require Remote Agents.

From the workspace root, build an installable archive:

```sh
pnpm --filter dsh-git-view pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-git-view-0.2.0.tgz"
```

For remote support, also build `pnpm --filter dsh-remote-agents pack:plugin` from this checkout and install that newly built archive into the **same DSH profile**. Choose the archive matching the version in the [Remote Agents manifest](../remote-agents/package.json), not an older download. Follow the [repository installation instructions](../../README.md#installation) when replacing an already installed plugin.

Restart the updated Web profile and refresh the browser. For Desktop, fully quit DSH, use the application's bundled `dsh` command with `--profile desktop`, then reopen it; the npm CLI cannot manage the reserved Desktop profile. Install individual `.tgz` archives, not the private repository root. The shared editor and localization helpers are bundled; no separate helper-package installation is needed.

## Open Git and choose where it runs

The **Git** tab beside Chat, the **Git** page of the right sidebar and the `repo (branch)` marker left of the message box all open the same panel; the plugin's settings choose the tab, the sidebar or both. The marker is green when the work tree is clean and orange with changes.

With [`@xbzbing/dsh-git-panel`](https://www.npmjs.com/package/@xbzbing/dsh-git-panel) installed as well, its tab, sidebar page and marker show this plugin's panel in every conversation and this plugin's own entries step aside, so the conversation shows one Git of each. That plugin runs Git only on the DSH host, where a Remote Agents workspace is just a local anchor folder. Both plugins inject the same stylesheet class names; uninstalling dsh-git-panel is recommended.

There is no local/remote toggle:

- An ordinary conversation working directory runs Git on the **DSH host**, not necessarily the machine running your browser.
- A Remote Agents workspace anchor under `remote-workspaces` routes Git and file transfers through Remote Agents to the conversation's verified SSH host and directory. The Git header shows that host.
- A missing service or unverifiable remote target fails rather than falling back to Git in the local anchor. Configure/select a verified workspace in Remote Agents first. The plugin does not clone or synchronize a local copy to perform Git operations.

The UI follows DSH's English/Simplified Chinese locale and supports light and dark themes.

## Current functions

| Area | Available actions |
| --- | --- |
| Git overview | Branch tree (**All branches**, local branches in folders, remotes, tags) with ahead/behind; searchable commit graph (message or hash), author and time filters; commit details with refs and hover cards; a commit's files open its diff; switch branches, create and delete tags, revert or reset (soft/mixed/hard) a commit, with a second confirmation for destructive actions; fetch, pull (fast-forward), push and publish a new branch |
| Changes | Stats bar, staged and unstaged groups with per-file and batch stage, unstage and discard, multi-select; commit and **Amend**; stashes (save, apply, pop, drop); added/removed line counts; side-by-side diff pane |
| AI commit message | Generates a message in the style of the repository's history with the conversation's model, or a model fixed in the settings. **This sends the diff to that model's provider.** |
| File browser | Lazy directory tree with file-type icons, ignored entries dimmed; previews of code, Markdown (with mermaid diagrams), HTML and images; rooted at the project, or following the selected repository |
| Diffs | Unified, side by side, before and after; syntax highlighting, word-level emphasis, context expanded on demand, Ctrl/⌘+F find in place; images zoom, pan and go full screen |
| Repositories | Worktrees and nested repositories of the workspace are detected; the overview, changes and marker follow the one selected |
| Layout | Adapts to the panel's width: three columns, stacked, or one column that drills in, for the sidebar and narrow windows |
| Changed files beside the conversation | Monaco diff of HEAD and the working file, edit and save, merge-conflict resolution (see below) |
| File lists | Colored change letters on files and dots on affected folders in the local workspace tree and the Remote Agents file list |

The panel follows DSH's language (Simplified Chinese, English, Japanese, Spanish, French, German, Russian and Portuguese; others fall back to English) and its light and dark themes. It refreshes its snapshot every 30 seconds while visible, after an agent's turn and after its own actions.

### Settings

On the plugin's detail page: the input-bar marker, the panel's placement (tab, sidebar or both), the default diff view, the graph style (parallel lanes or compact), the font size, worktree and nested-repository detection, whether the file browser follows the selected repository, and the AI commit message (on or off, language, input budget, output tokens, timeout, and an optional fixed provider, model and effort). The profile also holds the command timeout, output limit, change-list limit and refresh interval.

### Diffs and conflict resolution

Changed supported code/text files can open as a diff beside the conversation, from DSH's file tree or the Remote Agents file list. A **Git diff** option is also offered for supported built-in file previews, without replacing their default viewer. **Open the file** returns to another available viewer.

The Monaco comparison is **HEAD versus the current working-tree file**, combining staged and unstaged changes. An untracked file compares against an empty file; deleted files compare against an empty working version.

Use side-by-side or inline mode, word wrap, fold unchanged regions, font size controls, or edit mode. **Save** / ⌘/Ctrl+S writes the working file; **Stage** stages the on-disk file, not unsaved editor text. Save first. Local file I/O uses a short-lived Node helper process bound to verified directories, with file/directory identity, metadata and content-hash checks. Replacing a parent directory cannot redirect that worker’s data I/O or temporary-file cleanup into the replacement. Saves use atomic rename, but there is no cross-process compare-and-swap: an uncooperative external writer can still race the final check-to-rename interval. This is neither a sandbox nor an absolute lost-update guarantee. If the conversation changes workspace, the old draft remains visible but editing, saving and staging are disabled until you explicitly Reload into the new workspace. Reload discards the old draft; preserve any edits you need first.

Conflict blocks offer **Accept current**, **Accept incoming** and **Accept both** (current then incoming), with surrounding context and folded unchanged lines. Standard and diff3 markers are recognized. Review the result and choose **Save and resolve** to write and stage that file. This action is disabled while conflict markers remain; it checks the saved revision before staging. If saving succeeds but staging fails, the UI reports the partial success and keeps the new saved revision: inspect the error and retry staging rather than assuming the save was rolled back. Ordinary **Save** remains save-only, and **Stage** remains a separate on-disk action. Resolving and staging a file does not itself commit or finish a merge/rebase/cherry-pick; commit in the panel or use Git in a terminal to continue or abort. During a rebase, interpret current/incoming according to Git's conflict sides rather than assuming they mean your original local/remote branch.

## Credentials and safety

- Existing Git credential helpers and SSH keys on the executing machine continue to work. Git does not wait for an interactive password, editor or pager (`GIT_TERMINAL_PROMPT=0`); a network command without usable credentials fails with a sign-in error. Configure credentials and the Git author identity beforehand.
- HTTPS credentials saved by Git View 0.1 (`$DSH_HOME/storages/dsh-git-view/git-credentials`, unencrypted, mode `0600`) still apply to this plugin's local Git commands for their host. The panel no longer offers a form to save new ones. **Remote credentials are never saved**; configure a credential helper or SSH key on the remote machine.
- Commands are argv arrays without a shell, run in the repository's root, with a timeout and an output limit. The panel does not use `--force` or change Git configuration. Commit, amend, stage, discard, stash, branch switch, tag, revert and reset are explicit actions; destructive ones ask a second time; nothing is pushed automatically.
- **Discarding an untracked entry deletes it** from the work tree after confirmation; an entry that is itself a repository is refused. In a remote workspace untracked entries are removed with `git clean`, other files through Remote Agents only when unchanged since they were read.
- The file browser and previews read only files inside the repository or project root, after a containment check; `.git` cannot be browsed. In a remote workspace, links are not resolved on the remote machine.
- **AI commit messages send the diff of the chosen changes to the model provider configured in DSH.** The model call is made by DSH; the plugin holds no credentials. Turn the button off in the settings if this is not acceptable.
- The plugin makes no network requests of its own and collects no telemetry; fetch, pull and push reach the Git server only when you choose them. Panel preferences such as column widths stay in the browser's local storage.
- These are direct user-interface Git operations, not model tool calls subject to the agent's per-tool approval flow. They run with the executing account's permissions. Git configuration, hooks and filters can execute programs; use trusted repositories.

## Limits

- Per command: a 20-second timeout locally (network commands six times as long) and at least 30 seconds over SSH (network commands three times as long), and a 4 MiB output limit; the change list stops at 1,000 entries. Larger repositories may show truncated data, which the panel says.
- In a remote workspace every Git command is one SSH round trip, and file sizes and times come from one folder listing per folder; the panel is slower there than locally. Image diffs of a repository whose root is above the workspace folder are not available remotely.
- Files cannot open in a desktop application from a remote workspace.
- No clone/init, hunk staging, interactive rebase or remote management.

### Relationship to dsh-git-panel

The panel's source under `src/gp/` is [`@xbzbing/dsh-git-panel`](https://github.com/xbzbing/dsh-git-panel) 1.10.0 (MIT), commit `3e7c566`, with these changes: requests go to this plugin's `POST /api/git-view/gp` route instead of a typert service; its commands and file reads run through this plugin's local runner or Remote Agents (`src/gp-host.ts`); its identities, locale namespace and settings are this plugin's; its GitHub version check is removed. See the [third-party notices](THIRD_PARTY_NOTICES.md). Its own unit tests were run against this copy: 709 of 730 pass; the other 21 check its package identity and build output, release files, RPC transport and version check, which this copy replaces.

## Development checks

Use the root workspace dependencies and pinned pnpm version; see the [development guide](../../docs/development.md). From the repository root:

```sh
pnpm --filter dsh-git-view typecheck
pnpm --filter dsh-git-view test
pnpm --filter dsh-git-view build
# Or all three:
pnpm --filter dsh-git-view check

# Shared editor and same-checkout remote integration:
pnpm --filter @dsh-plugins/file-view check
pnpm --filter dsh-remote-agents check
pnpm --filter dsh-git-view pack:plugin
```

The test script includes server/parser tests, the panel host's local and remote adapters, and React/jsdom client tests; the client tests stand in DSH's UI primitives through `test/support/`. There is no package `test:ui` script. The deterministic [local-file safety suite](test/files-safety.test.ts) exercises directory/root swaps, file identity and content changes, temporary-file tampering, cancellation/cleanup, alias saves, permissions, text encodings and size limits. These checks do not eliminate the final-check-to-rename race described above. Before shipping, inspect the archive for server/client entry points, the on-demand editor and its notices, both READMEs and the license. In a disposable local repository and a verified remote repository, manually check the panel's three tabs, branch switching, commit and amend, discard, diffs, conflict save/stage, decorations and sign-in failures in both locales/themes. These are checks to perform, not a claim that every host or workflow has been validated.

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
