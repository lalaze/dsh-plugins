# DSH Workspace Tags

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates.

`dsh-workspace-tags` adds colored tags to the workspaces in the DeepSeek Harness sidebar, a row of tag chips that narrows the sidebar to one tag, and two more **Group by** choices in the sidebar’s view options.

Under the sidebar header, **All** and one chip per tag pick which workspaces the sidebar shows, in every grouping, so tags such as “Work” and “Personal” act as separate spaces. Pick a chip again to go back to All. A chip you are not in shows a spinner while any of its sessions runs, and how many of its sessions need you (waiting for you, or finished and not opened yet), orange when any is waiting. Without a unified provider, search covers every native workspace and opening another space switches to All. Tags start in name order; drag a tag chip to move it, near the row's edge to reach chips scrolled out of view. The Tag sections, the tag menu and **Manage tags…** follow that order, a new tag goes last, and the order is kept on the DSH host, shared by the desktop app and remote web clients. The phone still lists tags by name.

- **Tag**: one section per tag, in the chips' order, then **Untagged**. A workspace with several tags appears under each of them.
- **Status**: **Waiting for you** (an agent is waiting for an approval, a plan review or an answer), **Finished, your turn** (a session finished and you have not opened it yet; once opened it stays until you leave it or send the next message), **Running** (an agent is executing, itself or through a subagent), then **Idle**. The two sections that need you have a tinted header and a solid badge, and list their sessions even while another session of the same workspace runs. **Running** shows the running sessions and the open one; the workspace's other resting sessions wait behind **Show more** and stay out of **Idle**, and the section badge counts only running sessions. A workspace with nothing running lists its resting sessions in **Idle**. **Idle** also holds workspaces without sessions, counts workspaces where the others count sessions, and starts folded. Each status has its own icon, and the sections follow live as agents start and stop.

A folded workspace row shows what its sessions would: a badge counting those that need you, or a spinner when one is only running. Choose **Tags…** in a workspace's right-click or **⋯** menu to tick its tags, create a tag (name and color) that is added to that workspace, or open **Manage tags…** to rename, recolor or delete tags. A workspace’s tags show as small dots at the end of its row in every grouping mode. Sections fold, and the Group by choice, folded sections and the chosen tag chip are remembered per browser. Inside a section, workspaces keep the sidebar’s order; drag workspaces into order under Workspace grouping, since a workspace can appear in several sections. Sessions drag into order inside any section, Running, Waiting and Completed included. A drop saves that workspace’s session order (switching **Order by** to **Manual**, as a drag does under Workspace grouping), so the order holds in every grouping and after a restart.

Tags are stored on the DSH host in `~/.dsh/storages/dsh-workspace-tags/tags.json` (under `DSH_HOME` when set), so the desktop app and remote web clients of the same host share them; open clients pick up changes from others within 3 seconds while visible, or when their window regains focus. Other host plugins can read and replace the tags through the `workspaceTags` service; [Device Sync](../device-sync/README.md) uses it to share tags with a paired machine. Deleting a workspace in the sidebar removes its tags.

Build and install:

```sh
pnpm --filter dsh-workspace-tags check
pnpm --filter dsh-workspace-tags pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-workspace-tags-0.2.0.tgz"
```

Requires DSH 0.2.2-rc.1 or a later 0.2 release. On DSH 0.2.1, stay on 0.2.4: DSH refuses to install this version there.

## 0.3.0 The sidebar of DSH 0.2.2

- The sidebar is now built on DSH 0.2.2-rc.1's, so it has that release's improvements: the right-click menu on sessions and workspaces, **Show in folder**, the official worktree and pull request icons on session rows, the working directory in a session's hover card, and better keyboard and touch use.
- **Tags…** is an item in DSH's own workspace menu, from a right-click or **⋯**. A right-click no longer opens the tag menu directly.
- Update DSH first, then this plugin. Version 0.2.4 keeps working on DSH 0.2.2 until you do, without those improvements.

## 0.2.4 Tag chip drops no longer get lost

- Letting go of a tag chip right as the pointer entered another chip could do nothing. Every drop on the row now lands.

## 0.2.3 Drag tags into order

- Drag a tag chip to move it; **All** and **Untagged** stay in front. Near the row's edge it scrolls to the chips out of view.
- The Tag sections, the tag menu and **Manage tags…** follow that order, and a new tag goes last. Until the first drag, tags stay in name order.
- The order is kept on the DSH host, shared by the desktop app and remote web clients. The phone still lists tags by name.

## 0.2.2 finished tasks stand out

- Under **Status**, sessions waiting for you and finished sessions always list in their own sections at the top, even while another session of the same workspace runs, so a workspace can now appear in several sections.
- **Completed** is now **Finished, your turn**, and both sections that need you have a tinted header and a solid badge.
- **Running** shows the running sessions and the open one. The workspace's other sessions wait behind **Show more**.
- A finished session you open stays in its section until you leave it or send the next message.

## 0.2.0 unified presentation

> Device Sync was removed on 2026-11-02. The `sidebar.workspaces.presentation` and `sidebar.workspaces.viewOptions` slots remain; with no provider the sidebar shows this machine only, as in 0.1.10. The notes below and earlier are kept as released.

Workspace Updated order uses the maximum timestamp of raw current members before search/archive/hidden/child visibility filters. A hidden native reusable blank contributes its timestamp without becoming a visible row. Retained removed mirror history stays readable but does not contribute workspace recency.

Initial synced-history loading is disclosed in the shared header instead of prematurely claiming no matches. Errors remain explicit; provider withdrawal restores ordinary native empty states. Running status includes waiting and activity derived from existing same-owner direct-child metadata, independently of child visibility, without extending the sync protocol.

With **Device Sync 0.2.0**, one owner-qualified presentation collection contains native and mirrored workspaces/history; the device dropdown and remote section are removed. Workspace, directory-tree, flat, tag and status views share filtering, search, sorting, counts and empty states. Existing labels are not renamed/merged/reassigned, and identical paths do not identify the same workspace.

Project chips remain during unified search. Native full-text/metadata hits and mirror metadata hits share one result set, with a visible capability note. Without Device Sync, native cross-project search is retained. Updated ordering spans owners; Manual uses original owner workspace order plus a stable qualified tie-break, never local-first. There is no new synchronized global drag order: safe native-local reordering remains, cross-owner drops are rejected, and mirror IDs never enter native order storage. Unexported native pin/unread-completion state is not fabricated for mirrors.

The new `sidebar.workspaces.presentation` slot is a renderless client bridge: combine first, then render, rather than concatenate lists. Genuine native nodes retain native actions; mirror branches cannot instantiate native action slots/controllers. Provider error/unmount invalidates old actions while retaining native browsing. The original sliders menu retains hidden/subagent options. Inline mirror tag editing preserves per-item acknowledgment, pinned editors, retry and filter-change cancellation; see Device Sync's documentation.

Automated tests cover swapped-owner collection/order, identity collisions, native interactions, same-ID main-panel return, stale search, cross-owner drag rejection and tag edits. Real two-machine GUI acceptance remains a separate deployment step.

## 0.1.13 release notes

- Adds an optional `sidebar.workspaces.viewOptions` component slot to the **existing** sliders menu beside Workspaces. Device Sync 0.1.4 contributes a labeled remote-session group with the hidden/subagent visibility options; the owner supplies native menu-row rendering and the contributor retains state outside the menu lifetime.
- Device selection and project-tag rows are unchanged. Without a contributor no remote section or empty separator appears. No execution or host registry behavior changes.

## 0.1.12 release notes

- Clearly labeled **Project tags** (All / Untagged / existing labels) plus an independent **Device** dropdown supplied by Device Sync 0.1.3. Device uses owning DSH identity, not tag names or SSH hosts. It filters both native and mirrored workspace lists without changing the active conversation/executor. Device-filter slot occupancy and provider error/loading cleanup keep local workspaces visible when the provider is unavailable.
- Untagged is independent view state, not a catalogue entry; deleted-tag residue is ignored. All existing tags, names and assignments are preserved. Labels remain shared across machines. Global search remains cross-project within the chosen devices; the project row is hidden during search.
- Local Group by behavior is unchanged. Activity badges remain local-only and are hidden in remote-only views. Remote workspace tag names and in-place Save/Cancel editing are provided by Device Sync; only explicit assignment deltas are sent. See its README for partial-write, cancellation and linked-workspace semantics.
- Device control is single-line, project chips scroll horizontally, and the remote branch fills the available list area in remote-only mode.

## 0.1.11 release notes

- Adds the optional `sidebar.workspaces.remote` client-only extension seat inside the ordinary workspace browser, with the current tag ID, query and archive filter. Device Sync 0.1.2 contributes owner-qualified remote workspaces and sessions here and opens a real main-area conversation panel. With Device Sync absent, local browsing is unchanged.
- Remote nodes never enter the native host workspace/session registries or local row action menus. While the remote conversation panel is active, local new/add/fork/archive/rename shortcuts cannot operate on the previously selected local session. Returning to local chat restores its normal shortcuts.
- The remote branch preserves device/workspace grouping. Local Group by modes and local activity counters are unchanged; assigning remote groups remains in Device Sync settings.

## 0.1.10 release notes

- Open sidebars pick up tag changes from other clients within 3 seconds instead of 30; a refresh that finds nothing new returns an empty response.
- Other host plugins can read, replace and watch the tags through the new `workspaceTags` service.

## 0.1.9 release notes

- A tag chip you are not in shows a spinner while any session in its space runs, beside its attention badge.

## 0.1.8 release notes

- Running keeps a workspace's sessions behind **Show more**, as the sidebar does, while its running and attention-needing sessions stay in view.
- Inside a Tag or Status section, workspace rows and their sessions sit one level in from the section header.

## 0.1.7 release notes

- Keep every session visible in a running workspace, without duplicating the workspace in other status sections.
- Count only running sessions in the Running badge; folded workspace rows still show waiting or unread-completion attention.

## How it replaces the sidebar

DSH’s sidebar workspace browser (`@deepseek-ai/dsh-client-ui-workspace`) offers no extension point for workspace rows or grouping modes, so this package contains a copy of it from DSH 0.2.2-rc.1 with the tag features added, and its bundle patch disables the stock browser. Everything else in the browser, including search, pinning, archiving, drag ordering, shortcuts, and plugins’ **Add workspace** flows such as dsh-remote-agents’ remote workspaces, works as in DSH. Uninstalling the package restores the stock browser.

The copy follows the DSH release it was taken from. After a DSH update the sidebar keeps that release’s browser behavior until the package is updated; see [docs/upstream.md](docs/upstream.md) for how the copy is kept in step and what to do if DSH refuses the plugin.

The copied DSH code is MIT-licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).
