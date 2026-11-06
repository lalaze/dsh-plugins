# Vendored ui-workspace

DSH's sidebar workspace browser is one `single` slot (`sidebar.workspaces`) filled by `@deepseek-ai/dsh-client-ui-workspace`. It has no extension point for a Workspace row's menu, right-click, or new Group by modes, and a second registration cannot take over the slot: it would have to redeclare the `sidebar.workspaces.directoryFlow` hole that the native and browse pickers and dsh-remote-agents fill, and a hole has one declarer. So this package ships a copy of ui-workspace and its bundle patch disables the stock one.

`src/client/upstream/` is `packages/client/ui-workspace/src/client` from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) at tag `dsh-v0.2.2-rc.1` (commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`). Every change is marked with a `workspace-tags:` comment; the tag code itself lives in `src/client/tags/`.

| File | Change |
| --- | --- |
| `index.ts` | `apply(ctx, tagging)` passes the tag runtime to the browser; deleting a Workspace also drops its tags; **Tags…** joins DSH's Workspace menu as a `ctx.contextMenus` contribution, opening where `tags/menu-anchor.ts` says |
| `contract/slots.ts` | Optional `tagging` field on the browser's injected props |
| `locales.ts` | Tag copy (`tags/locales.ts`) joins the `workspace` namespace; languages other than Chinese and English read it in English |
| `rows/Rows.module.css`, `rows/WorkspaceBrowser.module.css` | Under a Workspace row, its Session rows and their "show more" button sit one 12px level inside it (`--dsh-session-indent`; DSH's `AnimatedRows` keeps a leaving row's computed padding); the flat list stays flush. Inside a Tag or Status section, Workspace and Session rows sit one more 12px level in (`--dsh-section-indent`) |
| `rows/Rows.tsx` | Workspace row: trailing tag dots, and `data-tag-workspace` for the tag menu's keyboard anchor |
| `rows/WorkspaceBrowser.tsx` | Tag and Status in Group by; Tag/Status sections in the session tree, which turn off Workspace drag and row motion because a Workspace can appear in several sections, and whose Waiting and Completed sections list only the Sessions in their state, even in a Workspace that also runs something, and hold the open Session's completion until the user leaves it, while Running shows running Sessions and the open one, keeps the Workspace's resting Sessions behind a "Show more" of its own and counts only running Sessions (Waiting, Completed and Running unfolded and with their own folds), unfolding for a search reveal; Session rows drag in every section, only among the rows of the section copy they left, and the drop saves their Workspace's manual order; the tag chip row under the header, whose tag chips drag into order, and its filter in the tree and flat list, including their empty state; folded Workspace rows' attention badge; a search result outside the filter clears it |

`node scripts/upstream-diff.mjs` prints these changes. The fork leaves ui-workspace's own view store and its `dsh.workspace.view.v5` key alone: the Tag/Status choice, folded sections and the tag filter are kept separately (`dsh-workspace-tags.view.v1`), so uninstalling never leaves the stock browser with a value it does not know.

## Moving to a new DSH release

1. `node scripts/upstream-diff.mjs <tag>` shows how the release's ui-workspace differs from this copy, including the changes above.
2. Replace `src/client/upstream/` and `test/upstream/` with the release's `src/client` and `tests`, rewrite the specs' `'../src/client/` imports to `'../../src/client/upstream/`, and reapply the marked changes.
3. Update the DSH versions together: the `@deepseek-ai/*` dev dependencies, `PLATFORM_MODULES` and `INLINE_SAFE` in `scripts/build-client.mjs` (from the release's `packages/client/web/src/platform.ts` and `packages/client/tsdown.client.ts`), the `dsh.client.inject` list (ui-workspace's own), the pnpm `packageExtensions` for this release in the workspace root, `engines.dsh`, and the fixtures under `test/fixtures/` that `dsh-client-test-runtime` and the specs import from DSH's unpublished sources.
4. `pnpm --filter dsh-workspace-tags check`.

## Tests

Vitest runs eight of ui-workspace's fifteen spec files against the published 0.2.2-rc.1 packages: `tree`, `path-suffix`, `browser-styles`, `rows`, `workspace-browser`, `workspace-picker`, `session-actions` and `session-context-menu`. `test/fixtures/client-bundles.ts` turns DSH's module-loader `client.js` bundles back into importable modules for them. The other seven construct the stock ui-workspace client or runtime classes that DSH publishes only inside those bundles' private scope, so they would need DSH's source tree.

## If DSH refuses the plugin

The copy needs the `contextMenus` service, which DSH 0.2.1 does not have, so `engines.dsh` starts at 0.2.2-rc.1. DSH 0.2.1 refuses to install this version and rolls the install back, leaving its sidebar as it was. Update DSH first, then the plugin: 0.2.4 still loads on DSH 0.2.2, without the newer sidebar features.

DSH applies every installed bundle patch before it checks plugin compatibility, and an incompatible plugin is only disabled. So this version on a DSH 0.2.1, put there by hand, by `allow-version`, or by downgrading DSH, would keep the stock browser disabled and leave the sidebar without workspaces. Uninstalling the package restores the stock browser. A host whose plugins are copied rather than installed, like the Mac mini hub, must update DSH before it copies this version.
