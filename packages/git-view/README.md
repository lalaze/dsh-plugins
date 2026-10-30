# Git View

**English** | [简体中文](README.zh-CN.md)

Git for DeepSeek Harness conversations: branches, a commit graph, changes and Monaco diffs in the right sidebar, for both local and Remote Agents workspaces. Package: `dsh-git-view`.

## Requirements and installation

- DSH `>=0.2.1-rc.2 <0.3.0`, with the right-sidebar and conversation UI services; Node.js ≥ 22.15.0.
- Git on the machine that holds the repository. On macOS, Apple's `/usr/bin/git` requires the Xcode Command Line Tools (`xcode-select --install`).
- **Remote workspaces require `dsh-remote-agents` 0.2.62 or newer**, exposing Git workspace API version 1. Install both plugins into the same DSH profile. Earlier releases and unversioned experimental Git services fail closed instead of silently ignoring workspace binding. Local workspaces do not require Remote Agents.

From the workspace root, build an installable archive:

```sh
pnpm --filter dsh-git-view pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-git-view-0.1.0.tgz"
```

For remote support, also build `pnpm --filter dsh-remote-agents pack:plugin` from this checkout and install that newly built archive into the **same DSH profile**. Choose the archive matching the version in the [Remote Agents manifest](../remote-agents/package.json), not an older download. Follow the [repository installation instructions](../../README.md#installation) when replacing an already installed plugin.

Restart the updated Web profile and refresh the browser. For Desktop, fully quit DSH, use the application's bundled `dsh` command with `--profile desktop`, then reopen it; the npm CLI cannot manage the reserved Desktop profile. Install individual `.tgz` archives, not the private repository root. The shared editor and localization helpers are bundled; no separate helper-package installation is needed.

## Open Git and choose where it runs

Open a conversation in a Git project and choose **Git** in the right sidebar. The branch button above the message box also lets you switch local branches.

There is no local/remote toggle:

- An ordinary conversation working directory runs Git on the **DSH host**, not necessarily the machine running your browser.
- A Remote Agents workspace anchor under `remote-workspaces` routes Git and file transfers through Remote Agents to the conversation's verified SSH host and directory. The Git header shows that host.
- A missing service or unverifiable remote target fails rather than falling back to Git in the local anchor. Configure/select a verified workspace in Remote Agents first. The plugin does not clone or synchronize a local copy to perform Git operations.

The UI follows DSH's English/Simplified Chinese locale and supports light and dark themes.

## Current functions

| Area | Available actions |
| --- | --- |
| Branches | Local and remote branches, latest commit subject/date, upstream ahead/behind and gone indicators; search branch names and tip subjects; copy names |
| Switching | Double-click a local branch (or press Enter) to switch; activate the current branch to pull; activate a remote branch to create a local tracking branch |
| Branch menu | Pull the current branch, fetch all with prune, rename a local branch, merge another branch into the current one, delete a non-current local or remote branch |
| Graph | Colored lanes, commit subjects and branch labels; resizable columns remembered in this browser; select a commit for hash/author/date, cherry-pick or revert |
| Changes | Conflict, staged and unstaged groups; per-file stage, unstage, discard, copy path and diff; commit, push, sync, stash and pop latest stash |
| Conversation | Add change-review, commit-message, file-review, diff or conflict-analysis prompts to the message draft; these actions do **not** send the message automatically |
| File lists | Colored change letters on files and dots on affected folders in the local workspace tree and Remote Agents file list |

Operations show progress, results and errors; running panel operations offer **Cancel**. Refresh/Status rereads the repository. Visible workspace status is polled with caching (local status fresh for 3 seconds, remote for 10 seconds); branch/graph data is refreshed when opening the panel, after its operations or on manual refresh. External changes are not a real-time Git event stream.

### Diffs and conflict resolution

Changed supported code/text files can open as a diff beside the conversation. A **Git diff** option is also offered for supported built-in file previews, without replacing their default viewer. **Open the file** returns to another available viewer.

The Monaco comparison is **HEAD versus the current working-tree file**, combining staged and unstaged changes, not an index-only or index-versus-worktree diff. The panel's staged rows instead open an index-versus-HEAD patch (`git diff --cached`), showing staged changes only. Other inline panel diffs use `git diff HEAD`, including both staged and unstaged changes. An untracked file has no inline Git patch, while the full comparison shows it against an empty file; deleted files compare against an empty working version.

Use side-by-side or inline mode, word wrap, fold unchanged regions, font size controls, or edit mode. **Save** / ⌘/Ctrl+S writes the working file; **Stage** stages the on-disk file, not unsaved editor text. Save first. Local file I/O uses a short-lived Node helper process bound to verified directories, with file/directory identity, metadata and content-hash checks. Replacing a parent directory cannot redirect that worker’s data I/O or temporary-file cleanup into the replacement. Saves use atomic rename, but there is no cross-process compare-and-swap: an uncooperative external writer can still race the final check-to-rename interval. This is neither a sandbox nor an absolute lost-update guarantee. If the conversation changes workspace, the old draft remains visible but editing, saving and staging are disabled until you explicitly Reload into the new workspace. Reload discards the old draft; preserve any edits you need first.

Conflict blocks offer **Accept current**, **Accept incoming** and **Accept both** (current then incoming), with surrounding context and folded unchanged lines. Standard and diff3 markers are recognized. Review the result and choose **Save and resolve** to write and stage that file. This action is disabled while conflict markers remain; it checks the saved revision before staging. If saving succeeds but staging fails, the UI reports the partial success and keeps the new saved revision: inspect the error and retry staging rather than assuming the save was rolled back. Ordinary **Save** remains save-only, and **Stage** remains a separate on-disk action. Resolving and staging a file does not itself commit or finish a merge/rebase/cherry-pick; use Git in a terminal for continue/abort operations not exposed here. During a rebase, interpret current/incoming according to Git's conflict sides rather than assuming they mean your original local/remote branch.

## Credentials and safety

- Existing Git credential helpers and SSH keys on the executing machine continue to work. Git does not wait for an interactive password, editor or pager; configure credentials and Git author identity beforehand.
- On a **local HTTPS authentication failure**, the panel can save a username and password/token and retry. Credentials are stored **unencrypted**, in Git's store format, at `$DSH_HOME/storages/dsh-git-view/git-credentials` (default `~/.dsh/storages/dsh-git-view/git-credentials`), with file mode `0600`. Treat this file and its backups as secrets; it is not an OS keychain.
- Saved credentials are scoped to an HTTPS **host**, not an individual repository. For that host, only this plugin's Git commands override other credential helpers. The plugin does not copy system-keychain secrets into its store or change terminal Git configuration. Prefer a least-privilege, revocable token; manage/remove stored entries outside the UI if needed.
- **Remote credentials are never saved by Git View.** Configure a credential helper or SSH key on the remote machine. The local credential store is not forwarded to it.
- **Commit stages all repository changes first** (`git add -A`, then `git commit -m`), including non-ignored untracked files, not merely the staged group or the conversation's subdirectory. Review the whole repository before committing.
- **Stash includes tracked changes only** (`git stash push`, without `-u`); untracked and ignored files remain. Pop applies the latest stash and may conflict.
- **Sync fetches fresh tracking information, pulls only when behind, then pushes when the branch was ahead or behind.** Its pull uses `git pull --no-rebase --ff --no-edit --no-autostash`: fast-forward where possible, merge otherwise, without rewriting commits or automatically stashing edits. It requires an attached branch with an upstream; an ongoing rebase/merge/cherry-pick/revert must be finished or explicitly aborted first. When behind, commit or stash tracked changes before syncing. Untracked-file collisions may still make Git refuse the pull. Sync is not file synchronization; the separate Pull action uses ordinary `git pull` and repository configuration.
- Discard restores a tracked file from the index (staged changes remain), or deletes an untracked file with `git clean -f`. Local branch deletion uses **force delete** (`git branch -D`), even for unmerged work; remote deletion pushes a branch deletion. The UI asks for confirmation for discard and branch deletion, but not for every mutation.
- These are direct user-interface Git operations, not model tool calls subject to the agent's per-tool approval flow. They run with the executing account's permissions. Git configuration, hooks and filters can execute programs; use trusted repositories. Workspace path and revision checks are not a general Git sandbox.
- Cancel or timeout stops a running command where possible and skips remaining batch commands; it does **not** undo completed changes, commits, hooks or network effects. Inspect status after interruption or failure.

## Limits

- The graph reads at most **300 commits** across all refs (`--all --date-order`), with no older-history pagination.
- Text comparison/editing is limited to **4 MB (4 × 1024 × 1024 bytes)** per file. Binary/NUL-containing files and non-UTF-8 working files are not text-editable. The editor operates on existing files inside the conversation workspace; repository-wide status may also list paths outside that folder.
- Inline panel diff rendering is limited to 30,000 characters; sending that diff to the message draft includes at most 8,000 characters. Use the full file comparison or terminal for larger reviews.
- Each Git command captures at most 8 MiB stdout and 64 KiB stderr. Typical timeouts are 20 seconds for reads/quick changes, 60 seconds for hook-capable changes and 90 seconds for network operations; longer operations may need a terminal.
- No clone/init, arbitrary new-branch creation, hunk staging, stash browser, force-push or merge/rebase continue/abort UI is provided. Git View is not a replacement for every Git CLI operation, and **complete feature parity with `dsh-git-panel` has not been verified**.

### Relationship to dsh-git-panel

[dsh-git-panel](https://github.com/a792883583/dsh-git-panel) is a UI reference, not a compatibility contract. The source-comparison baseline is version **0.1.20**, commit [`661685f4dc53eae3ccf9d16358911024dcfcde9e`](https://github.com/a792883583/dsh-git-panel/tree/661685f4dc53eae3ccf9d16358911024dcfcde9e). Its source uses pull-with-rebase for Sync and separate save/stage actions; Git View’s non-rebasing Sync and explicit Save-and-resolve are intentional improvements, not claims of identical behavior.

Comparison scope is the user-facing branch, graph, change, diff, conflict and conversation workflows described here, not every upstream API or host. This repository intentionally supports English/Simplified Chinese rather than upstream’s English/Chinese/Spanish, and requires DSH 0.2.1-rc.2 or newer within the declared range rather than upstream’s 0.1.5 minimum. The local worker has currently been tested on macOS; do not infer verified cross-platform compatibility. The limits above and untested interactions remain limitations or verification gaps, not verified complete parity.

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

The test script includes server/parser tests and React/jsdom client tests; there is no package `test:ui` script. The deterministic [local-file safety suite](test/files-safety.test.ts) exercises directory/root swaps, file identity and content changes, temporary-file tampering, cancellation/cleanup, alias saves, permissions, text encodings and size limits. These checks do not eliminate the final-check-to-rename race described above. Before shipping, inspect the archive for server/client entry points, the on-demand editor and its notices, both READMEs and the license. In a disposable local repository and a verified remote repository, manually check branch switching, diffs, conflict save/stage, decorations, credentials failures and cancellation in both locales/themes. These are checks to perform, not a claim that every host or workflow has been validated.

MIT. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
