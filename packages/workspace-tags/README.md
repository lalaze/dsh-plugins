# DSH Workspace Tags

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates.

`dsh-workspace-tags` adds colored tags to the workspaces in the DeepSeek Harness sidebar, and two more **Group by** choices in the sidebar’s view options:

- **Tag**: one section per tag, in name order, then **Untagged**. A workspace with several tags appears under each of them.
- **Status**: **Running** (an agent in the workspace is executing), **Waiting for you** (an agent is waiting for an approval, a plan review or an answer), **Completed** (a session finished and you have not opened it yet), then **Idle**. Each status has its own icon. A workspace with sessions in several states appears in each of those sections, and the sections follow live as agents start and stop.

Right-click a workspace, or choose **Tags…** in its **⋯** menu, to tick its tags, create a tag (name and color) that is added to that workspace, or open **Manage tags…** to rename, recolor or delete tags. A workspace’s tags show as small dots at the end of its row in every grouping mode. Sections fold, and the Group by choice and folded sections are remembered per browser. Inside a section, workspaces keep the sidebar’s order; drag workspaces into order under Workspace grouping, since a workspace can appear in several sections.

Tags are stored on the DSH host in `~/.dsh/storages/dsh-workspace-tags/tags.json` (under `DSH_HOME` when set), so the desktop app and remote web clients of the same host share them; open clients pick up changes from others within 30 seconds or when their window regains focus. Deleting a workspace in the sidebar removes its tags.

Build and install:

```sh
pnpm --filter dsh-workspace-tags check
pnpm --filter dsh-workspace-tags pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-workspace-tags-0.1.0.tgz"
```

Requires DSH 0.2.1-rc.3 or a later 0.2 release.

## How it replaces the sidebar

DSH’s sidebar workspace browser (`@deepseek-ai/dsh-client-ui-workspace`) offers no extension point for workspace rows or grouping modes, so this package contains a copy of it from DSH 0.2.1-rc.3 with the tag features added, and its bundle patch disables the stock browser. Everything else in the browser, including search, pinning, archiving, drag ordering, shortcuts, and plugins’ **Add workspace** flows such as dsh-remote-agents’ remote workspaces, works as in DSH. Uninstalling the package restores the stock browser.

The copy follows the DSH release it was taken from. After a DSH update the sidebar keeps that release’s browser behavior until the package is updated; see [docs/upstream.md](docs/upstream.md) for how the copy is kept in step and what to do if DSH refuses the plugin.

The copied DSH code is MIT-licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).
