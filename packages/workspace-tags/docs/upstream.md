# Vendored ui-workspace

DSH's sidebar workspace browser is one `single` slot (`sidebar.workspaces`) filled by `@deepseek-ai/dsh-client-ui-workspace`. It has no extension point for a Workspace row's menu, right-click, or new Group by modes, and a second registration cannot take over the slot: it would have to redeclare the `sidebar.workspaces.directoryFlow` hole that the native and browse pickers and dsh-remote-agents fill, and a hole has one declarer. So this package ships a copy of ui-workspace and its bundle patch disables the stock one.

`src/client/upstream/` is `packages/client/ui-workspace/src/client` from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) at tag `dsh-v0.2.1-rc.3` (commit `1f81c047fc48fa190a683e469daa699857e9afe8`). Every change is marked with a `workspace-tags:` comment; the tag code itself lives in `src/client/tags/`.

| File | Change |
| --- | --- |
| `index.ts` | `apply(ctx, tagging)` passes the tag runtime to the browser; deleting a Workspace also drops its tags |
| `contract/slots.ts` | Optional `tagging` field on the browser's injected props |
| `locales.ts` | Tag copy (`tags/locales.ts`) joins the `workspace` namespace |
| `tree.ts` | Exports `visiblePendingKind` and `runningChildCount` for Status grouping |
| `rows/Rows.tsx` | Workspace row: trailing tag dots, right-click, and a "Tags…" item in its menu |
| `rows/WorkspaceBrowser.tsx` | Tag and Status in Group by; Tag/Status sections in the session tree, which turn off Workspace drag and row motion because a Workspace can appear in several sections |

`node scripts/upstream-diff.mjs` prints these changes. The fork leaves ui-workspace's own view store and its `dsh.workspace.view.v5` key alone: the Tag/Status choice and folded sections are kept separately (`dsh-workspace-tags.view.v1`), so uninstalling never leaves the stock browser with a value it does not know.

## Moving to a new DSH release

1. `node scripts/upstream-diff.mjs <tag>` shows how the release's ui-workspace differs from this copy, including the changes above.
2. Replace `src/client/upstream/` and `test/upstream/` with the release's `src/client` and `tests`, rewrite the specs' `'../src/client/` imports to `'../../src/client/upstream/`, and reapply the marked changes.
3. Update the DSH versions together: the `@deepseek-ai/*` dev dependencies, `PLATFORM_MODULES` and `INLINE_SAFE` in `scripts/build-client.mjs` (from the release's `packages/client/web/src/platform.ts` and `packages/client/tsdown.client.ts`), the `dsh.client.inject` list (ui-workspace's own), the pnpm `packageExtensions` for this release in the workspace root, `engines.dsh`, and the fixtures under `test/fixtures/` that `dsh-client-test-runtime` and the specs import from DSH's unpublished sources.
4. `pnpm --filter dsh-workspace-tags check`.

## Tests

Vitest runs six of ui-workspace's twelve spec files against the published rc.3 packages: `tree`, `animated-rows`, `browser-styles`, `rows`, `workspace-browser` and `workspace-picker`, the ones covering the files this fork changes. `test/fixtures/client-bundles.ts` turns DSH's module-loader `client.js` bundles back into importable modules for them. The other six construct runtime classes (`LocaleRuntime`, `ShortcutRegistry`, the stock ui-workspace client) that DSH publishes only inside those bundles' private scope, so they would need DSH's source tree.

## If DSH refuses the plugin

DSH applies every installed bundle patch before it checks plugin compatibility, and an incompatible plugin is only disabled. If a DSH version outside `engines.dsh` refused this package, the stock browser would stay disabled too and the sidebar would show no workspaces. `engines.dsh` is therefore the whole 0.2 line; uninstalling the package restores the stock browser.
