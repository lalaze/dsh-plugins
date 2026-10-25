# DSH Usage Statistics

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-usage-stats` tracks DSH model calls and remote Claude Code turns made through `dsh-claude-ssh`. Open **Settings → Usage statistics** to filter by source, UTC date, provider, model or session, group by day/source/model/session, and export CSV.

The dashboard includes four headline metrics, a Token/request trend, a source breakdown, date presets, expandable filters and a paginated detail table. It supports light/dark themes and narrow windows. Trends include quiet dates and aggregate long ranges into at most 48 equal time buckets without dropping usage.

From the workspace root, with Node.js ≥ 22.15.0 and DSH `>=0.2.1-rc.2 <0.3.0`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter dsh-usage-stats check
corepack pnpm --filter dsh-usage-stats pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-usage-stats-0.1.1.tgz"
```

For Desktop, fully quit DSH, install with `--profile desktop`, and reopen. For Web, restart the profile and refresh. Install Claude SSH separately to collect that source; version 0.1.7 also forwards usage returned with failed remote results.

Each public `llm/stream` call counts once, including title generation and compaction. This counts stream calls, not individual HTTP attempts. Each Claude SSH turn records the remote `result.usage` aggregate, even if Claude performed several model calls. Provider IDs retain the host (`claude-ssh-<host>`); models retain the selected alias. Claude Code launched independently outside DSH is not collected. Collection starts when enabled; there is no historical import or account billing access.

Input tokens exclude cache reads/writes. Total tokens use the adapter's explicit total when available, otherwise input + output + cache reads + cache writes. Reasoning is already included in output. The last valid usage snapshot wins. Failed/cancelled calls retain reported usage; calls without usage count toward requests and are visibly marked as missing, with no estimated tokens. Disconnection may prevent final remote usage from arriving. Date bounds are inclusive and use the call's start time in UTC. Active calls appear after closing; the page refreshes every five seconds. Date presets roll forward across UTC midnight on automatic or manual refresh; custom date bounds stay fixed. Currency costs and subscription quota are not estimated.

Data is stored at `${DSH_HOME:-~/.dsh}/storages/dsh-usage-stats/usage.json`; configure `stateDir` to change it. Use separate directories per process/profile: concurrent processes writing to the same file are unsupported. Within one process, plugin reloads share the active store until all tracked calls finish, preserving records from both old and new calls. Records contain IDs, time, provider/model, session, purpose, status, duration and usage, without prompts, responses, tool contents or credentials. Writes use serialized atomic snapshots with mode `0600`. Write failures are logged and shown in the dashboard without breaking model calls. The failure count resets once the plugin is fully disabled and all tracked calls have finished. Invalid existing files prevent startup and remain untouched. All records currently reside in one JSON snapshot; costs grow with history size, with no automatic archival or retention policy.

Run `corepack pnpm --filter dsh-usage-stats test:ui` for browser checks using `agent-browser` and Chrome (`DSH_TEST_BROWSER_PATH` can override the executable). These exercise the real React component against a fixture API; they do not modify a DSH profile or call a real model. See the [Chinese documentation](README.zh-CN.md) for the accounting rules, host interfaces and validation scope.

Run `corepack pnpm --filter dsh-usage-stats preview:ui` to open a demo-only preview at `http://100.96.195.115:4182/#demo`. The server binds to `0.0.0.0`; override the port with `DSH_USAGE_PREVIEW_PORT`. It does not read real usage records.

MIT.
