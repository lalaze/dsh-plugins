# DSH Plugins

**English** | [简体中文](README.zh-CN.md)

A pnpm workspace for independently versioned DeepSeek Harness plugins. Each plugin has its own manifest, source, tests, documentation, and installable package.

| Package | Directory | Description |
| --- | --- | --- |
| `dsh-remote-agents` | [packages/remote-agents](packages/remote-agents/README.md) | Native DSH chat and task delegation over SSH: run Claude Code, Codex, DSH, Grok, CodeBuddy and Antigravity on remote machines, steer them, and let DSH delegate tasks to them |
| `dsh-session-models` | [packages/session-models](packages/session-models/README.md) | Model icons and status badges on sidebar sessions, with the exact model in the hover card |
| `dsh-workspace-tags` | [packages/workspace-tags](packages/workspace-tags/README.md) | Colored workspace tags, with sidebar grouping by tag or by running status |
| `dsh-usage-stats` | [packages/usage-stats](packages/usage-stats/README.md) | Track DSH and Claude SSH token usage with filters, grouped reports and CSV export |
| `dsh-gallery` | [packages/gallery](packages/gallery/README.md) | Bing daily wallpapers, local uploads, pinned backgrounds and image previews for DSH |
| `dsh-browser-devtools` | [packages/browser-devtools](packages/browser-devtools/README.md) | Chrome-style Elements, Console and Network debugger, docked or in a separate Chrome/Edge window |
| `dsh-translate` | [packages/translate](packages/translate/README.md) | Translate selected chat text and composer drafts through an OpenAI-compatible API |

## Languages

Plugin interfaces support English and Simplified Chinese. English is the source and fallback language. On hosts with the DSH locale service, plugins follow **Settings → General → Language** and update immediately, including open panels and known error messages. Older hosts without that service use English. API diagnostics and CSV column names use English; user content, model IDs and command syntax stay in their original language.

The private `packages/i18n` helper is bundled into each client at build time, so plugin archives remain independently installable.

## Setup

Requires Node.js ≥ 22.15.0 and pnpm **10.34.7**, pinned in `package.json`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm pack:plugins
```

If pnpm is already available at the pinned version, use `pnpm` directly. The repository uses a single `pnpm-lock.yaml`; run dependency installation at the workspace root.

## Development

```sh
pnpm build          # Build every package
pnpm typecheck      # Type-check every package
pnpm test           # Run package tests
pnpm check          # Type-check, test, then build
pnpm test:ui        # Run available browser regression suites
pnpm pack:plugins   # Build and pack packages into dist/
```

Work on one plugin with a package filter:

```sh
pnpm --filter dsh-remote-agents check
pnpm --filter dsh-remote-agents pack:plugin
```

## Installation

Remote Agents **0.2.23** lists only the current workspace machine’s remote models, grouped by Claude, Codex and other CLIs, in DSH's model picker and main conversation. The Open sessions button in settings brings history, follow-ups and pending approvals together; delegation tools remain available. Build `dist/dsh-remote-agents-0.2.23.tgz` with `pnpm --filter dsh-remote-agents pack:plugin`. See [install and upgrade](packages/remote-agents/README.md#install-and-upgrade), including what changed from 0.1.x.

Install an individual built archive into the desired DSH profile:

```sh
pnpm pack:plugins
dsh plugin --profile web add "$PWD/dist/dsh-remote-agents-0.2.23.tgz"
```

For Desktop, fully quit DSH and use the desktop application's bundled `dsh` command with `--profile desktop`, then reopen the app; the npm CLI cannot manage this reserved profile. For Web, restart the updated profile and refresh the browser. Plugins are not currently published to npm. The repository root is a private workspace; install individual plugin archives rather than the GitHub root.

### Plugin market

`pnpm release:market` builds every plugin, commits the install-ready packages to the `market` branch, and updates `index.json` there: a DSH plugin market index listing every released version, each pinned to a commit. Publish with `git push origin market`. A release requires a clean working tree; versions already in the index are skipped, and a plugin that changed without a version bump is reported. `--dry-run` previews the release. Never rewrite or force-push `market`, because installed versions resolve through its commits.

To install and update from DSH, open **Plugins**, switch on **Custom plugin markets** under experimental plugins, and add this index source on the **Discover** tab:

```text
https://raw.githubusercontent.com/lalaze/dsh-plugins/market/index.json
```

Discover marks a newer release **Update available** and opens the installed plugin’s detail page when clicked. Third-party plugins currently require uninstalling the old version before installing the new version from Discover or Add plugin; an installed plugin has no Install button. DSH offers one-click updates only for its official plugins.

## Layout and new plugins

```text
packages/
  remote-agents/        # dsh-remote-agents: source, tests, manifest, docs
  session-models/       # Model icons and status badges on sidebar sessions
  workspace-tags/       # Workspace tags and tag/status grouping in the sidebar
  usage-stats/          # DSH and Claude SSH usage statistics
  gallery/              # Local wallpaper library and DSH backgrounds
  browser-devtools/     # Docked / separate-window debugger for Sidebar Browser tabs
  translate/            # Chat selection and composer translation
scripts/
  build-client.mjs      # Shared DSH web client bundler
tsconfig.base.json     # Shared TypeScript compiler options
pnpm-workspace.yaml    # Discovers packages/*
pnpm-lock.yaml         # Workspace dependency lock
dist/                  # Generated installable archives (ignored)
```

Add each plugin under `packages/<plugin-name>` with a unique package name, its own version, and the standard `build`, `typecheck`, and `test` scripts. Root commands discover it automatically. Shared tools live at the root; plugin-specific dependencies belong to the plugin. Release plugins independently.

See [the development guide](docs/development.md) (Chinese) for manifests, client builds, packaging, and shared-code conventions.

MIT. See each plugin's documentation for third-party acknowledgments.
