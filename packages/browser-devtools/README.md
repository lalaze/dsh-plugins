# DSH Browser Debugger

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-browser-devtools` adds a Chrome-style debugger to DSH Desktop's Sidebar Browser. Click the debugger button beside the address bar:

- **DSH development builds** (run from source) allow DevTools for browser pages, so the button opens Chromium's own DevTools.
- **Released DSH** turns DevTools off for browser pages in its main process (`devTools: !app.isPackaged`), which a plugin cannot change. The button docks the plugin's debugger under the page instead.

The docked debugger lives in DSH's own window, not in the page, so page CSS cannot restyle it and it never covers the page. Drag its top edge to resize it; the height is remembered. It follows DSH's light or dark theme and language. A small agent injected into the page collects data for it:

- **Elements**: the DOM tree with Chrome's syntax colours, keyboard navigation, hover highlighting in the page (margin, border, padding and content boxes), and an inspect button to pick an element in the page. The sidebar shows inline styles and matched CSS rules (Styles) and a box model with every computed property (Computed).
- **Console**: page `console` output and uncaught errors, with level filters, text filter and repeat counts; a prompt evaluates JavaScript in the page with `$0` bound to the selected element.
- **Network**: Fetch, XMLHttpRequest and resource timing entries in a table (name, status, type, size, time) with Chrome's type filters.

The **Open debugger in a separate window** button (outward arrow) opens this same debugger in a Chrome / Edge app window. The inspected page stays in DSH; the window can be moved or placed on another monitor. Chrome or Edge must already be installed on the computer running DSH's backend. No companion app or desktop-source patch is required. The docked and separate modes are mutually exclusive for each page.

The plugin starts the browser with a temporary, isolated profile and a loopback-only HTTP bridge. It does not reuse your normal browser profile or expose a Chrome remote-debugging port. Each window stays attached to its original DSH tab, even when you select another tab. Page navigation resets its state and reconnects; closing either the DSH tab or debugger stops the session and removes the temporary profile. A lost DSH connection expires after roughly 20–25 seconds. Reopen the window from the toolbar if it loses its connection; refreshing the external window closes that session.

This feature is intended for a local DSH Desktop backend. With a remote/headless backend the browser would be launched on that backend machine, not on your desktop. Browser discovery supports standard Chrome/Edge installations on macOS and Windows, and Chrome/Edge/Chromium on Linux's PATH; the native app-window launch has been tested on macOS.

Build and install the plugin package:

```sh
pnpm --filter dsh-browser-devtools check
pnpm --filter dsh-browser-devtools pack:plugin
# Optional browser UI regression (requires agent-browser and Chrome):
pnpm --filter dsh-browser-devtools test:ui
```

Install the generated `.tgz` in DSH Desktop, restart DSH, open a Sidebar Browser tab, and click the debugger button beside the address bar. The debugger stays open across navigations and reconnects to each new page; close it with its × button or the toolbar button.

This is a page debugger rather than a full Chromium DevTools replacement. It reads what page scripts can read: no request headers or bodies, no cross-origin stylesheet rules, no breakpoints, and console messages only from the moment it connects to the page. Fetch and XHR started before it connected appear from resource timing, without method or status.

Verification: automated HTTP-bridge and renderer integration tests cover command round trips, navigation races, credentials, launch errors, lost connections, DOM/styles, console, network and cleanup. Browser UI tests use a simulated DSH guest; final installation in DSH Desktop remains a manual acceptance step.
