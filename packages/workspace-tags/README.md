# DSH Workspace Tags

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates.

`dsh-workspace-tags` adds colored tags to the workspaces in the DeepSeek Harness sidebar, a row of tag chips that narrows the sidebar to one tag, and two more **Group by** choices in the sidebar’s view options.

Under the sidebar header, **All** and one chip per tag pick which workspaces the sidebar shows, in every grouping, so tags such as “Work” and “Personal” act as separate spaces. Pick a chip again to go back to All. A chip you are not in shows a spinner while any of its sessions runs, and how many of its sessions need you (waiting for you, or finished and not opened yet), orange when any is waiting. Search still covers every workspace; opening a result from another space switches back to All.

- **Tag**: one section per tag, in name order, then **Untagged**. A workspace with several tags appears under each of them.
- **Status**: **Waiting for you** (an agent is waiting for an approval, a plan review or an answer), **Completed** (a session finished and you have not opened it yet), **Running** (an agent is executing, itself or through a subagent), then **Idle**. A workspace with any running session appears only in **Running**, with all its sessions folded behind **Show more** as in the sidebar; the section badge counts only running sessions. Otherwise a workspace appears in each state its sessions qualify for, listing only the sessions in that state. **Idle** also holds workspaces without sessions, counts workspaces where the others count sessions, and starts folded. Each status has its own icon, and the sections follow live as agents start and stop.

A folded workspace row shows what its sessions would: a badge counting those that need you, or a spinner when one is only running. Right-click a workspace, or choose **Tags…** in its **⋯** menu, to tick its tags, create a tag (name and color) that is added to that workspace, or open **Manage tags…** to rename, recolor or delete tags. A workspace’s tags show as small dots at the end of its row in every grouping mode. Sections fold, and the Group by choice, folded sections and the chosen tag chip are remembered per browser. Inside a section, workspaces keep the sidebar’s order; drag workspaces into order under Workspace grouping, since a workspace can appear in several sections.

Tags are stored on the DSH host in `~/.dsh/storages/dsh-workspace-tags/tags.json` (under `DSH_HOME` when set), so the desktop app and remote web clients of the same host share them; open clients pick up changes from others within 30 seconds or when their window regains focus. Deleting a workspace in the sidebar removes its tags.

Build and install:

```sh
pnpm --filter dsh-workspace-tags check
pnpm --filter dsh-workspace-tags pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-workspace-tags-0.1.9.tgz"
```

Requires DSH 0.2.1-rc.3 or a later 0.2 release.

## 0.1.9 release notes

- A tag chip you are not in shows a spinner while any session in its space runs, beside its attention badge.

## 0.1.8 release notes

- Running keeps a workspace's sessions behind **Show more**, as the sidebar does, while its running and attention-needing sessions stay in view.
- Inside a Tag or Status section, workspace rows and their sessions sit one level in from the section header.

## 0.1.7 release notes

- Keep every session visible in a running workspace, without duplicating the workspace in other status sections.
- Count only running sessions in the Running badge; folded workspace rows still show waiting or unread-completion attention.

## How it replaces the sidebar

DSH’s sidebar workspace browser (`@deepseek-ai/dsh-client-ui-workspace`) offers no extension point for workspace rows or grouping modes, so this package contains a copy of it from DSH 0.2.1-rc.3 with the tag features added, and its bundle patch disables the stock browser. Everything else in the browser, including search, pinning, archiving, drag ordering, shortcuts, and plugins’ **Add workspace** flows such as dsh-remote-agents’ remote workspaces, works as in DSH. Uninstalling the package restores the stock browser.

The copy follows the DSH release it was taken from. After a DSH update the sidebar keeps that release’s browser behavior until the package is updated; see [docs/upstream.md](docs/upstream.md) for how the copy is kept in step and what to do if DSH refuses the plugin.

The copied DSH code is MIT-licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).
