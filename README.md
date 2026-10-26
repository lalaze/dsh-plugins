# DSH Plugins

**English** | [简体中文](README.zh-CN.md)

A pnpm workspace for independently versioned DeepSeek Harness plugins. Each plugin has its own manifest, source, tests, documentation, and installable package.

**`dsh-claude-ssh` is a modified version of [Oh My Claude](https://github.com/lcestou/dsh-oh-my-claude), based on upstream version 1.5.5.** It retains the upstream Claude Code integration and adds verified remote-workspace routing, workspace-specific model visibility, and compatibility fixes for DSH. Thanks to the Oh My Claude authors for the original implementation. See [upstream provenance](packages/claude-ssh/UPSTREAM.md) and [third-party notices](packages/claude-ssh/THIRD_PARTY_NOTICES.md) for the exact revision and attribution.

| Package | Directory | Description |
| --- | --- | --- |
| `dsh-claude-ssh` | [packages/claude-ssh](packages/claude-ssh/README.md) | Use remote Claude Code over system OpenSSH in DSH |
| `dsh-remote-agents` | [packages/remote-agents](packages/remote-agents/README.md) | Complete Claude SSH integration plus direct SSH tasks for Claude, Codex, DSH, Antigravity, Grok and CodeBuddy, with approvals and recovery |
| `dsh-usage-stats` | [packages/usage-stats](packages/usage-stats/README.md) | Track DSH and Claude SSH token usage with filters, grouped reports and CSV export |
| `dsh-gallery` | [packages/gallery](packages/gallery/README.md) | Bing daily wallpapers, local uploads, pinned backgrounds and image previews for DSH |
| `dsh-magpie-fast` | [packages/magpie-fast](packages/magpie-fast/README.md) | GPT-only lightning toggle for priority processing on existing providers, including remote Magpie |
| `dsh-browser-devtools` | [packages/browser-devtools](packages/browser-devtools/README.md) | In-page element, Console and network debugger for DSH Sidebar Browser |
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
pnpm --filter dsh-claude-ssh check
pnpm --filter dsh-claude-ssh pack:plugin
```

Claude's check includes the upstream regression suite and remote-workspace compatibility checks. See the [plugin documentation](packages/claude-ssh/README.md#development-and-validation) for the distinction between offline tests and live verification.

## Installation

Download the merged [Remote Agents 0.4.3 archive](https://github.com/lalaze/dsh-plugins/releases/download/remote-agents-v0.4.3/dsh-remote-agents-0.4.3.tgz) without building. See the [installation and Claude migration instructions](packages/remote-agents/README.md#install-and-migrate) for use on another machine.

Install an individual built archive into the desired DSH profile:

```sh
pnpm pack:plugins
dsh plugin --profile web add "$PWD/dist/dsh-claude-ssh-0.3.2.tgz"
```

For Desktop, fully quit DSH and use the desktop application's bundled `dsh` command with `--profile desktop`, then reopen the app; the npm CLI cannot manage this reserved profile. For Web, restart the updated profile and refresh the browser. Plugins are not currently published to npm. The repository root is a private workspace; install individual plugin archives rather than the GitHub root.

## Layout and new plugins

```text
packages/
  claude-ssh/           # dsh-claude-ssh: source, tests, manifest, docs
  usage-stats/          # DSH and Claude SSH usage statistics
  gallery/              # Local wallpaper library and DSH backgrounds
  magpie-fast/          # GPT Fast composer toggle for existing providers
  browser-devtools/     # In-page debugger for Sidebar Browser tabs
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
