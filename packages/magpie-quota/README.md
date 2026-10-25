# Magpie account quotas

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-magpie-quota` adds a compact row of provider icons and remaining percentages below the DSH composer, one per account. Click an icon for its windows, reset countdowns, plan, balance, reading time and refresh button. **Settings → Magpie quota** shows every account.

Each icon shows the lowest remaining percentage among the account's known, limited windows. A 75% five-hour window and a 63% weekly window show 63%, with both windows listed in the details. Unlimited is `∞`, unknown is `—`. Warnings mark failed or deferred readings. Percentages are never added together or converted into estimated tokens.

## Install

Requires Node.js ≥ 22.19, DSH `>=0.2.1-rc.2 <0.3.0`, and Magpie with the quota endpoints. From the repository root:

```sh
pnpm --filter dsh-magpie-quota check
pnpm --filter dsh-magpie-quota pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-magpie-quota-0.1.0.tgz"
```

Restart that Web profile and refresh the browser. For desktop, install the same archive through the application's plugin management entry and reopen the app; some standalone CLI versions reserve the `desktop` profile.

## Connection

The plugin finds DSH providers with `magpie` in their ID or name and reuses their URL, headers and credentials. Explicit Authorization / x-api-key headers take precedence, then `apiKeyEnv`, then the provider's saved pi-ai API Key. Connection details stay on the backend. With no configured match, it tries local Magpie's configured port, default 3425.

Override the installed ID in the profile's `cordis.patch.yml` to select providers whose names do not contain Magpie:

```yaml
- id: dsh-magpie-quota
  config:
    providers: [office]
    cacheSeconds: 45
    discoverLocal: true
```

Alternatively configure `baseURL` and `apiKeyEnv` directly, with `discoverLocal: false`. URLs support a reverse-proxy prefix and an optional trailing `/v1`. An explicit provider list or URL disables automatic local fallback.

Remote access requires an enabled gateway key and network access. Restricted keys may need their owner to enable quota visibility with `magpie gateway-key quotas <id> on`; the returned accounts remain scoped to that key's permissions.

Visible pages synchronize every 30 seconds, sharing one query across composers and settings. The backend coalesces requests and caches readings for 45 seconds by default. Synchronization reads `/v1/magpie/quotas` and respects Magpie's own cache and allowance-reading policy. A manual account refresh uses the refresh endpoint, at most once per account per 30 seconds, then reads the canonical report. Claude account refreshes may run Claude Code's `/usage` on the Magpie host.

Failed network reads retain dated values. Authorization failures clear the old account list; credential changes isolate caches. Reading timestamps come from Magpie. Nested remote accounts can be displayed, but refreshing them requires connecting to their owning Magpie. The last-served mark does not predict the next routed request.

## Development

```sh
pnpm --filter dsh-magpie-quota check
pnpm --filter dsh-magpie-quota test:ui
pnpm --filter dsh-magpie-quota preview:ui
```

Preview: **http://100.96.195.115:4185/**, bound to `0.0.0.0`, with explicitly labeled demo data. Browser regression uses agent-browser and covers compact icons, details, refresh/errors, permissions, focus, light/dark themes, small viewports and many accounts. Unit tests cover normalization, credentials, caching, authorization changes and the DSH route. See the [Chinese documentation](README.zh-CN.md) for details.

MIT.
