/**
 * Runs first in a machine's page that the desktop window shows in a frame: lends the page the window's own browser.
 *
 * The window's page has the desktop app's bridge (`dshDesktop.browser`), and Electron defines `<webview>` only in the
 * window's main frame, so a framed page has neither. Calling the window's bridge from here still passes the desktop
 * app's main-frame check (the bridge runs in the main frame), and a `<webview>` the window's document makes works in
 * this page once added to it. The machine's listener serves DSH's browser panel to this page changed to take both from
 * `globalThis.__dshLinkDesktop` (browser-panel.ts).
 *
 * Addresses: the panel's webview loads an address of the machine (its `localhost`, its private network) from its guest
 * host on this computer's loopback, which forwards over the machine's network (forward/address.ts, window.ts). The
 * panel itself only ever sees the machine's own addresses: what it loads is mapped there, what it reads back and what
 * a page opens in a new tab is mapped back, and a link on the page that leads to an unmapped address of the machine is
 * sent to its guest host. Each machine keeps its own cookies and storage.
 *
 * Nothing happens outside the desktop window's frames.
 */
import { needsGuest, toDisplayUrl, toGuestUrl } from '../forward/address.js';
import { DESKTOP_GLOBAL, SHELL_GLOBAL } from '../rewrite.js';

export interface FrameConfig {
  machine: string;
  /** The window's forwarding port; 0 when it does not forward (pages then load from this computer). */
  port: number;
}

/** The desktop app's browser bridge (dsh-client-ui-sidebar-browser `DesktopBrowserBridge`). */
export interface DesktopBrowserBridge {
  acquire(workspace: string): Promise<unknown>;
  release(lease: string): Promise<void>;
  onOpenRequested(lease: string, listener: (url: string) => void): () => void;
}

/** The part of Electron's webview tag this script wraps. */
interface WebviewElement extends EventTarget {
  loadURL(url: string, options?: unknown): Promise<void>;
  getURL(): string;
  stop(): void;
}

interface NavigationEvent extends Event { url?: unknown; isMainFrame?: unknown; isInPlace?: unknown }

type WindowLike = { parent?: unknown } & Record<string, unknown>;
interface ShellWindow {
  dshDesktop?: { protocolVersion?: unknown; browser?: DesktopBrowserBridge };
  document: { createElement(tag: string): unknown };
}

/** Lend `win` the window's browser; false when `win` is not a machine's page in the desktop window. */
export function installFrameBrowser(win: WindowLike, config: FrameConfig | undefined): boolean {
  if (!config || typeof config.machine !== 'string' || !config.machine) return false;
  let shell: ShellWindow & Record<string, unknown>;
  try {
    const parent = win.parent as (ShellWindow & Record<string, unknown>) | undefined;
    if (!parent || parent === (win as unknown) || !parent[SHELL_GLOBAL]) return false;
    shell = parent;
  } catch { return false; }
  let bridge: DesktopBrowserBridge | undefined;
  try { bridge = shell.dshDesktop?.protocolVersion === 1 ? shell.dshDesktop.browser : undefined; } catch { return false; }
  if (!bridge) return false;
  const desktop = bridge;
  const { machine } = config;
  const port = Number.isInteger(config.port) && config.port > 0 ? config.port : 0;
  const shown = (url: string) => port ? toDisplayUrl(url, port) : url;
  const loaded = (url: string) => port ? (toGuestUrl(url, machine, port) ?? url) : url;

  const lent = {
    protocolVersion: 1,
    browser: {
      // Each machine's pages keep their own cookies and storage, apart from this computer's and each other's.
      acquire: (workspace: string) => desktop.acquire(`dsh-link:${machine}:${workspace}`),
      release: (lease: string) => desktop.release(lease),
      onOpenRequested: (lease: string, listener: (url: string) => void) => desktop.onOpenRequested(lease, url => listener(shown(url))),
    },
    createWebview(): unknown {
      const element = shell.document.createElement('webview') as WebviewElement;
      const loadURL = element.loadURL, getURL = element.getURL;
      Object.defineProperty(element, 'loadURL', { configurable: true, writable: true, value: (url: string, options?: unknown) => loadURL.call(element, loaded(url), options) });
      Object.defineProperty(element, 'getURL', { configurable: true, writable: true, value: () => shown(getURL.call(element)) });
      if (port) {
        const redirect = (event: NavigationEvent) => {
          if (event.isMainFrame !== true || event.isInPlace === true || typeof event.url !== 'string' || !needsGuest(event.url, port)) return;
          const to = toGuestUrl(event.url, machine, port);
          if (!to || to === event.url) return;
          try { element.stop(); } catch { /* not loading any more */ }
          loadURL.call(element, to).catch(() => { /* the panel shows the failure of the load it sees */ });
        };
        element.addEventListener('did-start-navigation', redirect);
        element.addEventListener('did-redirect-navigation', redirect);
      }
      return element;
    },
  };
  Object.defineProperty(win, DESKTOP_GLOBAL, { configurable: true, value: lent });
  return true;
}
