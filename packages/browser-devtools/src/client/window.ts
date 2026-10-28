import { DebuggerPanel, type PanelView } from './panel.js';
import { installLocale, ui } from './i18n.js';
import type { PageState } from '../protocol.js';

/** The browser window only holds its own short-lived credential, never the DSH owner token. */
export function startDebuggerWindow(win: Window): () => void {
  const doc = win.document;
  const target = doc.getElementById('target')!;
  const container = doc.getElementById('panel')!;
  const message = doc.getElementById('message')!;
  const [id, token] = win.location.hash.slice(1).split('.');
  // Keep the capability out of subsequent address/history copies and requests.
  win.history.replaceState(null, '', '/');
  let stopped = false, panel: DebuggerPanel | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let page: PageState | undefined, failures = 0, locale = 'en';
  const localeListeners = new Set<() => void>();
  const uninstallLocale = installLocale({ get: () => ({
    register: () => undefined, getSnapshot: () => ({ active: locale, revision: 0 }),
    subscribe: listener => { localeListeners.add(listener); return () => { localeListeners.delete(listener); }; },
  }) });
  const rpc = async <T>(input: Record<string, unknown>, keepalive = false): Promise<T> => {
    const response = await win.fetch('/rpc', { method: 'POST', cache: 'no-store', keepalive,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...input, id }), signal: AbortSignal.timeout(18_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not connect to the debugger window.');
    return result as T;
  };
  let replacing = false;
  const disposePanel = () => { const previous = panel; panel = undefined; replacing = true; previous?.dispose(); replacing = false; };
  const close = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); disposePanel(); uninstallLocale();
    win.removeEventListener('pagehide', close);
    void rpc({ action: 'close' }, true).catch(() => {});
  };
  const tick = async () => {
    try {
      const next = await rpc<PageState>({ action: 'status' });
      if (stopped) return;
      failures = 0; message.hidden = true;
      doc.body.toggleAttribute('data-ds-dark-theme', next.dark);
      if (locale !== next.locale) {
        locale = next.locale; doc.documentElement.lang = locale;
        for (const listener of localeListeners) listener();
        panel?.localize();
      }
      target.textContent = `${ui('Page debugger')} · ${next.url}`; target.title = next.url;
      doc.title = `DSH · ${ui('Page debugger')}`;
      if (!page || page.revision !== next.revision || page.ready !== next.ready) {
        page = next;
        disposePanel();
        const revision = next.revision;
        // A minimal view adapter runs the panel's page commands through the owner DSH renderer.
        const view = doc.createElement('div') as unknown as PanelView;
        view.getURL = () => next.ready ? next.url : '';
        view.executeJavaScript = (code, gesture = false) => {
          if (stopped || page?.revision !== revision || !page.ready) return Promise.reject(new Error('Page navigated'));
          return rpc({ action: 'execute', code, gesture, revision });
        };
        panel = new DebuggerPanel(doc, view, () => { if (!replacing) { close(); win.close(); } }, container);
        // Do not block heartbeats on a command waiting for the owner renderer.
        void panel.open().catch(() => {});
      } else page = next;
    } catch (error) {
      if (stopped) return;
      failures++;
      message.hidden = false;
      message.textContent = ui('Connection lost. Keep the DSH page open and reopen the debugger if needed.');
      if (error instanceof Error && error.message === 'Debugger window closed' || failures >= 5) {
        // A dead session cannot be resumed. Do not leave stale actionable controls behind.
        stopped = true; disposePanel(); uninstallLocale(); win.removeEventListener('pagehide', close);
        return;
      }
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, 500);
  };
  if (!/^[a-f0-9]{64}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(token ?? '')) {
    message.textContent = ui('Open this window from the DSH browser toolbar.'); uninstallLocale();
    return () => {};
  }
  win.addEventListener('pagehide', close);
  void tick();
  return close;
}

if (typeof window !== 'undefined') startDebuggerWindow(window);
