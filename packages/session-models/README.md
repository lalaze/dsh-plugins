# DSH Session Models

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-session-models` shows which model each conversation uses in the DeepSeek Harness sidebar. A vendor icon (Claude, OpenAI, DeepSeek, Gemini, Grok, Qwen, Kimi, GLM, Doubao, MiniMax, Mistral, Antigravity, CodeBuddy, or a generic mark) fills the cell before each session title. DSH’s own status mark stays visible as a small badge in the icon’s corner: a spinner while the session runs, a yellow dot while it waits for approval or an answer, green when finished, red on failure, and the clock for scheduled tasks. The row’s hover card adds the exact model and, for `dsh-remote-agents` sessions, the remote CLI.

Build and install:

```sh
pnpm --filter dsh-session-models check
pnpm --filter dsh-session-models pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-session-models-0.1.0.tgz"
```

The icon follows the model the session will use next, the same one DSH’s model picker shows. The model name decides the vendor first, so an aggregator or a multi-model CLI shows the model’s maker; otherwise the provider decides. Sessions whose history is not loaded get one read of DSH’s session projections when their row appears, without opening the conversation. Sessions saved in DSH’s older storage format report no model until they are opened once, which upgrades them; rows without a known model and archived rows keep DSH’s default look.

DSH has no extension point that renders beside its status mark, so the plugin decorates the sidebar with a stylesheet keyed on the row markup (`data-row-key="session:<id>"` and the row’s leading cell). It never modifies DSH’s DOM. A DSH update that changes that markup can hide the icons until the plugin is updated; status and navigation keep working.

`pnpm --filter dsh-session-models test:ui` runs a browser regression against a copy of the host row markup and requires `agent-browser`. Set `DSH_TEST_SCREENSHOTS=<dir>` to keep light and dark screenshots.

Logos come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT); see [third-party notices](THIRD_PARTY_NOTICES.md). Regenerate them with `node scripts/vendor-icons.mjs <extracted @lobehub/icons-static-svg>`.
