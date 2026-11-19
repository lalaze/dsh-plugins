# DSH PWA

**English** | [简体中文](README.zh-CN.md)

Serves DSH's Web App manifest (`/manifest.webmanifest`) with dark `theme_color` and `background_color` (`#151517`, DSH's dark theme base background) so that when DSH Web is installed to a phone's home screen (Android WebAPK), the bottom system navigation bar and keyboard switcher bar are dark instead of white.

## Why this is needed

Since 0.2.2-rc.1, DSH's built-in `manifest.webmanifest` sets `theme_color` and `background_color` to white (`#ffffff`). DSH sets `<meta name="theme-color">` from the page background after it boots, which colors the top status bar, but an installed Android WebAPK paints the bottom system navigation bar (including the strip beneath the soft keyboard with the dismiss and keyboard-switcher buttons) and its window background from the manifest: `theme_color` on Android 14 and earlier, `background_color` on Android 15+. So the bottom stays white even in dark mode.

## What the plugin does

- Reads the running DSH installation's own `manifest.webmanifest` (found through `frontend-static`'s dist, or the DSH package next to the running `dsh`) and serves it from an exact `/manifest.webmanifest` route on DSH's `webServer`, which takes precedence over `frontend-static`. Every field (`name`, `short_name`, `start_url`, `scope`, `display`, `icons`, …) is kept; only `theme_color` and `background_color` change (default `#151517`).
- Follows DSH's file: a DSH upgrade that changes the manifest is picked up on the next request.
- Has no manifest of its own. Until DSH's file has been read, the route stays DSH's and a warning is logged. If the file later disappears or stops parsing, the last good copy keeps being served, so the installed app is not changed by a half-finished upgrade.
- Changes nothing else: no page markup, no styles, and `<meta name="theme-color">` stays with DSH's theme presenter, so the top status bar keeps following Light / Dark / System appearance.

Server-only plugin with no client bundle. Safe on headless profiles (activates only when `webServer` is present).

**Trade-offs & update note:**
- A Web App manifest only supports a single static `theme_color` and `background_color`, so the Android system bottom bar stays dark even if you switch DSH to Light mode.
- On Android, an already-installed WebAPK does not pick up manifest changes immediately: uninstall and reinstall the Web App from Chrome to apply it right away, or wait for Chrome's periodic manifest update check.
- A reverse proxy in front of DSH that answers `/manifest.webmanifest` itself hides this plugin's manifest; let that path through to DSH.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `themeColor` | `#151517` | `theme_color` written into `/manifest.webmanifest` |
| `backgroundColor` | `#151517` | `background_color` written into `/manifest.webmanifest` |
| `display` | `""` | Optional `display` override (`fullscreen`, `standalone`, `minimal-ui`, `browser`); empty keeps DSH's own value |
| `manifestPath` | `""` | Optional explicit path to upstream `manifest.webmanifest`; empty auto-discovers DSH's file |

## Install

```sh
pnpm --filter dsh-pwa pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-pwa-0.1.0.tgz"
```

Restart or reload the Web profile, verify `/manifest.webmanifest` shows `"theme_color": "#151517"`, then reinstall the Web App on your phone.
