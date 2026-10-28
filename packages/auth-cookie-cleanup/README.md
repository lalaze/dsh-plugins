# DSH Auth Cookie Cleanup

**English** | [简体中文](README.zh-CN.md)

A temporary workaround for [deepseek-ai/deepseek-harness#10598](https://github.com/deepseek-ai/deepseek-harness/discussions/10598). Uninstall it once DSH ships an official fix.

## The problem

DSH Desktop starts its host on a random `127.0.0.1` port at each launch. The host names its 60-day browser-session cookie `dsh-auth-<sha256(host:port)>`, so every launch adds a new cookie and old ones are never removed. Cookies are not scoped by port, so all of them are sent on every request. After about 70 launches the `Cookie` header exceeds Node's 16 KB `maxHeaderSize`, the host rejects the request, and Desktop fails with `desktop welcome: Web authentication failed`.

## What the plugin does

The plugin listens on the host's `connection/request` hook, which runs only for requests that already passed authentication. If the request carries `dsh-auth-*` cookies other than the current port's cookie, the plugin adds `Set-Cookie` headers that expire them. The current session cookie is never touched. If the request carries no recognizable current cookie, the plugin changes nothing.

As a result, at most one stale cookie remains between launches, so the header can't grow anymore. The plugin is server-only and has no UI.

**Tradeoff:** if you run several `dsh web` instances on different ports in the **same browser**, each instance logs the others out. Desktop runs a single instance with its own cookie jar, so it is unaffected.

## Already can't open?

Once the header is too large, Node rejects the request before any plugin code runs. Clean the cookie store once, then install the plugin:

1. Fully quit DSH Desktop.
2. Run the bundled script against the Electron user-data directory, or directly against its `Network/Cookies` file:

   ```sh
   node bin/reset-auth-cookies.mjs "<user-data dir>" --dry-run   # count only
   node bin/reset-auth-cookies.mjs "<user-data dir>"             # delete + backup
   ```

   The script deletes only `dsh-auth-*` rows for `127.0.0.1`, `localhost` and `[::1]`, and first writes `Cookies.bak-<timestamp>`. It requires Node ≥ 22.15 (`node:sqlite`).

Without Node, you can instead rename `Network/Cookies` and `Network/Cookies-journal` while the app is closed. This also signs you out of other sites inside the app.

## Install

```sh
pnpm --filter dsh-auth-cookie-cleanup pack:plugin
dsh plugin --profile desktop add "$PWD/dist/dsh-auth-cookie-cleanup-0.1.0.tgz"
```

For Desktop, fully quit the app and use its bundled `dsh` command. For Web, use `--profile web` and restart.
