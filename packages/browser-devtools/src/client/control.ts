/** The small subset of Electron's webview tag used by the client plugin. */
export interface Inspectable extends EventTarget {
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  openDevTools?(): void;
  closeDevTools?(): void;
  isDevToolsOpened?(): boolean;
}

export interface State {
  ready: boolean;
  /** The docked debugger panel is open. */
  opened: boolean;
  /** Chromium's own DevTools window is open for this page. */
  native: boolean;
  busy: boolean;
  error?: 'unavailable' | 'failed';
}

/** The docked panel as the controller sees it. */
export interface Panel {
  readonly opened: boolean;
  open(): Promise<void>;
  close(): void;
}

/**
 * Opens Chromium's DevTools for the page where DSH allows it (development builds), otherwise
 * the docked debugger. Packaged DSH turns DevTools off for Sidebar Browser guests in its main
 * process, so `openDevTools()` does nothing there and the panel takes over.
 */
export function controlDevTools(view: Inspectable, panel: Panel, changed: (state: State) => void, nativeWaitMs = 300) {
  let disposed = false;
  let state: State = { ready: false, opened: false, native: false, busy: false };
  const emit = () => { if (!disposed) changed({ ...state }); };
  const ready = (): boolean => { try { return /^https?:\/\//i.test(view.getURL()); } catch { return false; } };
  const nativeOpen = (): boolean => { try { return view.isDevToolsOpened?.() === true; } catch { return false; } };
  const refresh = () => { state.ready = ready(); state.opened = panel.opened; state.native = nativeOpen(); emit(); };

  const listeners: Record<string, EventListener> = {
    'dom-ready': refresh,
    'did-navigate': refresh,
    'did-stop-loading': refresh,
    'devtools-opened': refresh,
    'devtools-closed': refresh,
    'render-process-gone': () => { state = { ...state, ready: false, busy: false }; emit(); },
    destroyed: () => { state = { ...state, ready: false, busy: false }; emit(); },
  };
  for (const [event, listener] of Object.entries(listeners)) view.addEventListener(event, listener);
  refresh();

  return {
    async toggle(): Promise<void> {
      if (disposed || state.busy) return;
      if (nativeOpen()) { try { view.closeDevTools?.(); } catch { /* Already closed. */ } refresh(); return; }
      if (panel.opened) { panel.close(); refresh(); return; }
      refresh();
      if (!state.ready) return;
      state = { ...state, busy: true, error: undefined }; emit();
      if (typeof view.openDevTools === 'function') {
        try { view.openDevTools(); } catch { /* DevTools disabled for this guest. */ }
        await new Promise(resolve => setTimeout(resolve, nativeWaitMs));
        if (disposed) return;
        if (nativeOpen()) { state.busy = false; refresh(); return; }
      }
      try {
        await panel.open();
        state.error = undefined;
      } catch (error) {
        state.error = error instanceof Error && error.message === 'layout' ? 'unavailable' : 'failed';
      }
      if (disposed) return;
      state.busy = false;
      refresh();
    },
    /** The panel closed itself (its close button). */
    sync: refresh,
    dismiss() { state.error = undefined; emit(); },
    dispose() {
      disposed = true;
      for (const [event, listener] of Object.entries(listeners)) view.removeEventListener(event, listener);
    },
  };
}
