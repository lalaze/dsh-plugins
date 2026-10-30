# Git View validation — 2026-10-30

Continues Claude's original implementation and supersedes the first handoff report. Versions: **Git View 0.1.0 / Remote Agents 0.2.62**. This records acceptance before commit/publication; subsequent release packaging is documented in the [release record](../../docs/releases/2026-10-30.md). The user's current Desktop profile and GUI were not installed into or restarted.

## Reference and scope

Reference: [dsh-git-panel 0.1.20, commit 661685f4dc53eae3ccf9d16358911024dcfcde9e](https://github.com/a792883583/dsh-git-panel/tree/661685f4dc53eae3ccf9d16358911024dcfcde9e), MIT. This is a source-level comparison, not merely a comparison against its README.

| Reference capability | Git View implementation |
| --- | --- |
| Branch list/search/status; switch/tracking checkout, pull/fetch/rename/delete/merge; composer branch button | Implemented for local and verified SSH workspaces |
| Graph lanes, virtualized rows, remembered column widths, commit details/cherry-pick/revert | Implemented; explicit 300-commit bound |
| Grouped changes, commit-all/push/stash/pop; per-file stage/unstage/discard/copy/chat actions | Implemented; rename unstaging handles both literal paths |
| HEAD/worktree split/inline editor, counts/wrap/folds/font/edit controls, original viewer, file decorations | Implemented; staged sidebar patches separately compare index to HEAD |
| Conflict current/incoming/both choices, context, normal save and stage | Implemented, with an additional validated **Save and resolve** action |
| Sync | Deliberate safety improvement: fetch/count, behind-only non-rebase pull, conditional push; refuse unresolved integration state |
| Credentials | Local HTTPS store/retry; SSH credentials remain on the SSH host and are not forwarded |

The pinned upstream source still uses unconditional `pull --rebase` then push, and separate save/stage actions, despite differing README claims. Its stash button has no description input; optional descriptions exist at API level, as here. Git View deliberately does not silently abort a user's rebase. Language and host scope are not identical: this repository follows English/Simplified Chinese conventions, not upstream Spanish fallback, and requires the declared newer DSH interface range. This report does not certify pixel-identical UI, every upstream API, or every operating system. See the [README](README.md) for operational limits.

## Implementation completed in this continuation

- Safe, cancellable Sync spanning preflight, fetch, counts, optional pull and push. Detached/no-upstream/in-progress states produce actionable errors. A conflicted merge remains available for explicit recovery instead of being silently aborted.
- Explicit Save and resolve rejects remaining marker lines, saves with a revision check, rechecks the saved version, and stages only that file. A staging failure after a successful write is reported as partial success, with the saved revision retained. It does not commit the merge.
- Slow comparison/save responses preserve newer edits. Dirty diffs retain their original workspace binding until explicit Reload; compare/save/stage and resolution assert the expected cwd.
- Git and file transfers pin the verified SSH host/directory through asynchronous discovery. Cancellation follows the original job even after retargeting. Older/unversioned remote services fail closed through Git workspace API version 1. Mutation cancellation is registered **before** cwd/SSH-target discovery, persists across batches, and rejects duplicate in-flight IDs; seven deterministic regressions cover these early windows.
- Local file operations use a short-lived Node worker with its own verified directory binding, regular-file descriptors and identity/metadata/hash checks. Replacement ancestors cannot redirect its basename I/O or temporary-file cleanup. Alias saves serialize in-process. Temporary content is verified before atomic rename.
- Actual host UI acceptance found that tab-local navigation drops an explicit viewer kind. Git View now uses the public `sidebarRight.openResource` service for both opening a diff and returning to the ordinary viewer; the regression exercises both directions.
- Remote Agents was versioned to 0.2.62, with bilingual changelogs and updated installation requirements. No immutable published package was overwritten.

## Automated and packaged checks

On macOS with Node 22:

| Check | Result |
| --- | --- |
| Git View TypeScript and complete test suite | Passed; **73 tests** |
| Deterministic local file safety cases (included above) | **14 passed** |
| Shared file-view TypeScript and tests | Passed; **12 tests** |
| Remote Agents TypeScript and build | Passed |
| Remote workspace expanded regression | **58 passed**, including repaired platform fixtures |
| Git View build and package | Passed |
| Extracted final archive server import, local worker read/save, stale-save rejection and pre-discovery cancellation | Passed |
| `git diff --check` | Passed |

Safety tests cover root/parent replacement (including between observation and chdir), inode/type/content replacement, temporary-file tampering, cancellation cleanup, concurrent alias saves, permissions, BOM/CRLF, invalid UTF-8/binary content and size limits.

The three primary related suites total **143 passing tests** (73 Git View + 12 shared editor + 58 remote workspace). This is **not** a claim that the entire Remote Agents suite is green.

Broader regression exposed test-isolation problems: runtime PATH discovery selected host CLIs instead of test doubles, and macOS `/var` versus `/private/var` paths made a terminal fixture enter an interactive fallback shell. These were fixed only in the [relay harness](../remote-agents/test/relay-harness.ts), [relay test](../remote-agents/test/relay.test.ts) and [terminal test](../remote-agents/test/workspace-connections.test.ts). The obsolete bad-PATH-implies-no-Node case now explicitly tests an `old-node` installation-probe response; it does not pretend to test absence of every fallback runtime.

Remaining out-of-scope results, with production agent/relay/sharing code left untouched:

- Relay: **17/21 passed**. Four offline approval/resume/deletion cases were cancelled with a pending unresolved promise; tracing identified an offline `service.resume()` wait.
- Shared sessions: **19 distinct cases passed across splits/retry**, with one intermittent teardown `ENOTEMPTY` cleanup race in a grouped run.
- Remaining suites: **219/221 passed**, with two socket-forward sharing assertions failing (reuse and reattachment cleanup). Isolated reruns showed environment/timing sensitivity; the [sharing tests](../remote-agents/test/sharing.test.ts#L286-L307) were not weakened or edited.

These residual failures/cancellations are disclosed, not counted as passing or silently excluded from a purported whole-suite result.

## Fresh archive acceptance

The new archives were installed using the public DSH plugin CLI into Claude's existing **isolated** temporary Web profile at `http://127.0.0.1:38231/`, not the user's Desktop GUI. The previous isolated server PID was verified before termination. A bounded test harness owns each replacement test process and cleans it up in `finally`.

- Both plugins and their final client bundles loaded; Remote Agents reports 0.2.62.
- Actual local Git and SSH Git API checks: **19 passed on each target with the final archive**. Checks include verified routing, compare/edit/save, stale-version and expected-cwd refusal, staging, staged-only versus full diffs, unresolved-marker refusal, successful Save and resolve with fully staged index verification, branch switch/restoration, and safe Sync or actionable missing-upstream refusal.
- Local and SSH fixture files, index and branch were restored. Sync intentionally updated only the disposable local origin.
- Actual SSH conflict UI acceptance passed: marker-disabled resolution button, Accept both, Save and resolve, staged index, ordinary Monaco edit/save, default viewer and remote file/folder decorations. Local Monaco edit/save and native file/folder decorations also passed. The corrected final archive's **local and SSH explicit diff → normal viewer → diff navigation both passed**, without browser/page console errors. The final 19-check API run on each target followed restoration of the deliberate local UI edit.

Machine-readable outputs and the bounded test harness are under the ignored [initial QA directory](../../dist/git-view-qa/) and [final acceptance directory](../../dist/git-view-final/). See the [final acceptance report](../../dist/git-view-final/RESULTS.md) and [artifact fingerprints](../../dist/git-view-final/fingerprints.json). Final verification found no local changes, only the pre-existing remote untracked file, and the isolated server port closed.

## Validated pre-release archives

- [Git View 0.1.0](../../dist/git-view-final/dsh-git-view-0.1.0.tgz) — SHA-256 `71fa36be69e1b233873685fb7e8a808d0e0ac9c33c0b37b775138316e7f2d2b5`.
- [Remote Agents 0.2.62](../../dist/git-view-final/dsh-remote-agents-0.2.62.tgz) — SHA-256 `734b01be96b8d067e22b5a25e3407ce3a23f21092e8f7a4ea1ee53c2a3cc26bd`.

These local acceptance artifacts are ignored by Git and are not part of a fresh source clone. Release archives may include later documentation/manifest updates with identical runtime bytes. Each archive has a SHA-256 sidecar. Earlier handoff/QA archives are superseded; same-version Git View archives from earlier in this session do not contain the final navigation and early-cancellation fixes.

## Explicit residual limits

Atomic rename is not an operating-system compare-and-swap against an uncooperative external writer: the final verification-to-rename window still exists. These checks are not a general filesystem/Git sandbox or an absolute lost-update guarantee. Git hooks, filters and configuration execute with the user's privileges.

The local worker and final Web runtime were exercised on macOS/Node. No Electron runtime is installed on the SSH test host; actual Desktop, Windows and Linux-host local-worker validation are not claimed. SSH operations do not require Node on the remote Git host. Installation into the user's current Desktop profile remains a separate, explicitly requested action.

Unrelated workspace-tags changes and art assets were preserved and are outside this validation.
