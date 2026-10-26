# DSH Gallery

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

A device-local wallpaper library for DeepSeek Harness, inspired by Paseo's wallpaper interactions and implemented independently for DSH. Open **Settings → Gallery** to browse and apply backgrounds to chat and the sidebar.

- Archive the latest eight Bing daily wallpapers, preserving dates and attribution.
- Check hourly while the application is visible and backgrounds are enabled.
- Pin an image or resume daily rotation; keep archiving while pinned.
- Upload JPG, PNG and WebP, up to 10 MB and 40 megapixels per image, 20 files per upload.
- Filter, search, preview, navigate with arrow keys, zoom, download and delete.
- Adjust opacity, blur and Bing region while preserving menu and composer surfaces.
- Restore images and preferences from IndexedDB after reload; cached images work offline.

## Install

Requires Node.js ≥ 22.15.0 and DSH `>=0.2.1-rc.2 <0.3.0`, using its Web or desktop Web renderer. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter dsh-gallery pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-gallery-0.1.1.tgz"
```

Restart the profile and refresh. In Settings → Gallery, fetch wallpapers or upload images, then enable the background switch. Click a photo to open its full-size preview and save the original. Hover a card to reveal apply/delete actions and metadata; touch devices show the overlay directly. Backgrounds default to off; applying an image pins it and enables backgrounds. For desktop, fully quit the application and use its bundled `dsh` command with `--profile desktop`, then reopen it. The npm CLI cannot manage the reserved `desktop` profile.

## Data

Images and preferences belong to the current device and application origin. Uploads stay on the device. Automatic checks require the application to be open, visible and backgrounds enabled; manual refresh is always available. The first refresh retrieves eight days, and later refreshes build the archive over time. Older images unavailable from Bing cannot be backfilled.

Images and metadata commit in one transaction. Download failure preserves saved wallpapers. The current image and the selected region's latest daily image are protected from deletion. Clearing browser or application data deletes the library. Unloading the plugin removes its background and styles, retaining saved images for reinstalling at the same origin.

The DSH host must reach `www.bing.com`. Original attribution links are retained. Bing images are neither bundled nor relicensed by the plugin.

## Development

```sh
pnpm --filter dsh-gallery check
pnpm --filter dsh-gallery test:ui
pnpm --filter dsh-gallery preview:ui
```

Browser tests require `agent-browser` and Chrome. They use a separate session, deterministic Bing responses and real IndexedDB to cover persistence, uploads, daily/pinned modes, failure recovery, previews, mobile layout and cleanup. Set `DSH_TEST_BROWSER_PATH` for a custom executable and `DSH_GALLERY_SCREENSHOT_DIR` for screenshots.

The standalone preview binds `0.0.0.0:4183` and uses the live Bing service. Open `http://100.96.195.115:4183/`; override the port with `DSH_GALLERY_PREVIEW_PORT`. Its simplified shell and storage are separate from the installed application.

The backend registers only `/api/gallery/bing` and `/api/gallery/image` GET routes through DSH's authenticated connection. Images accept fixed Bing IDs with size limits, timeouts and redirects disabled.

MIT.
