import { guestScript, type GuestCommand, type GuestState } from './guest.js';
import { activeLocale } from './i18n.js';

/** The small subset of Electron's webview tag used by the client plugin. */
export interface Inspectable extends EventTarget {
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface State {
  ready: boolean;
  opened: boolean;
  busy: boolean;
  error?: 'unavailable' | 'failed';
}

interface GuestResult extends GuestState {
  available?: boolean;
}

function isGuestResult(value: unknown): value is GuestResult {
  return typeof value === 'object' && value !== null
    && typeof (value as { opened?: unknown }).opened === 'boolean';
}

/**
 * Controls the in-page debugger without asking Electron to expose its native
 * DevTools window. Each command is evaluated in the selected webview guest,
 * so a tab can never affect another tab.
 */
export function controlDevTools(view: Inspectable, changed: (state: State) => void, timeoutMs = 3000) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let state: State = { ready: false, opened: false, busy: false };
  const emit = () => { if (!disposed) changed({ ...state }); };
  const cancel = () => { clearTimeout(timer); timer = undefined; };

  const ready = (): boolean => {
    try { return /^https?:\/\//i.test(view.getURL()); } catch { return false; }
  };

  const refresh = () => {
    if (disposed) return;
    state.ready = ready();
    if (!state.ready) state.opened = false;
    emit();
  };

  const query = async () => {
    if (disposed || !ready() || state.busy) return;
    try {
      const value = await view.executeJavaScript(guestScript('state', activeLocale()), false);
      if (isGuestResult(value)) {
        state.opened = value.opened;
        state.error = undefined;
        emit();
      }
    } catch {
      // A guest can disappear between getURL and executeJavaScript during a
      // navigation. The next dom-ready event will establish the new state.
    }
  };

  const settled = (result: unknown, opening: boolean) => {
    cancel();
    state.busy = false;
    if (!isGuestResult(result) || result.available === false) {
      state.error = 'unavailable';
      state.opened = false;
    } else {
      state.opened = result.opened;
      state.error = result.opened === opening ? undefined : 'failed';
    }
    emit();
  };

  const gone = () => {
    cancel();
    state = { ready: false, opened: false, busy: false };
    emit();
  };

  const listeners: Record<string, EventListener> = {
    'dom-ready': () => { refresh(); void query(); },
    'did-navigate': gone,
    'did-stop-loading': () => { refresh(); void query(); },
    'render-process-gone': gone,
    destroyed: gone,
  };
  for (const [event, listener] of Object.entries(listeners)) view.addEventListener(event, listener);
  refresh();
  poller = setInterval(() => { void query(); }, 700);

  return {
    toggle() {
      if (disposed || state.busy) return;
      refresh();
      if (!state.ready) return;
      const opening = !state.opened;
      state = { ...state, busy: true, error: undefined };
      emit();
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        state.busy = false;
        state.error = 'failed';
        emit();
      }, timeoutMs);
      const command: GuestCommand = opening ? 'open' : 'close';
      void Promise.resolve()
        .then(() => view.executeJavaScript(guestScript(command, activeLocale()), true))
        .then(result => { if (!disposed) settled(result, opening); })
        .catch(() => {
          if (disposed) return;
          cancel();
          state = { ...state, busy: false, error: 'failed' };
          emit();
        });
    },
    dismiss() { state.error = undefined; emit(); },
    dispose() {
      disposed = true;
      cancel();
      if (poller !== undefined) clearInterval(poller);
      for (const [event, listener] of Object.entries(listeners)) view.removeEventListener(event, listener);
    },
  };
}
