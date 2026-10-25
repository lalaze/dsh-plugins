# DSH Browser Debugger

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-browser-devtools` adds a small debugger to DSH Desktop's Sidebar Browser. It runs inside the selected page, so it does not require Electron's native DevTools to be enabled.

The floating panel provides:

- element picking with a box and HTML/style summary;
- captured `console` output and page errors;
- Fetch, XMLHttpRequest, and resource timing entries.

Build and install the plugin package:

```sh
pnpm --filter dsh-browser-devtools check
pnpm --filter dsh-browser-devtools pack:plugin
```

Install the generated `.tgz` in DSH Desktop, restart DSH, open a Sidebar Browser tab, and click the debugger button beside the address bar. The panel is injected into the current page and is removed with the close button or when the page is reloaded.

This is a page debugger rather than a full Chromium DevTools replacement. It cannot inspect browser process internals, extension frames, or requests made before it was opened.
