/**
 * Switching without reloading. The window's own page (the shell) keeps every other machine's page it opened in a frame
 * over itself and only shows or hides them, so going back to a machine already open is instant and keeps where it was.
 * Every machine's page is served by this host (its mount), so the frames are same-origin: a framed page finds the
 * shell on its parent and goes through it to switch, and the shell asks a framed page to open a conversation.
 */
import { currentSession, mountedId, mountPrefix, rawStorage, selectSession, SHELL_GLOBAL, SHELL_KEYS, storagePrefix } from '../rewrite.js';

const KEY = SHELL_GLOBAL;
const SHOWN = SHELL_KEYS.shown;
const MODE = SHELL_KEYS.keepPages;
/** After this long without its page coming up, a frame offers to open the machine directly. */
const HINT_MS = 20_000;
/** A frame whose document loaded but whose page did not come up within this is likely an error page. */
const HINT_AFTER_LOAD_MS = 8_000;

/** Tell this computer's DSH Link how switching went in this window (read back at `/dsh-link/diag`). */
export function report(event: string, detail: Record<string, unknown> = {}): void {
  try {
    void fetch('/dsh-link/diag', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, ...detail }) }).catch(() => undefined);
  } catch { /* diagnostics only */ }
}

/**
 * ⌘R, which reloads the page in a browser. The desktop app gives it to DSH's right sidebar and never reloads its window,
 * and a machine's page in a frame is a web page there, where nothing handles it: so the shell reloads that page.
 */
export const isReloadKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'code' | 'key'>) =>
  event.metaKey && !event.ctrlKey && !event.altKey && (event.code === 'KeyR' || event.key.toLowerCase() === 'r');

/** What a framed page offers the shell. */
export interface FrameHandle { openSession(sessionId: string): void }

export interface Shell {
  readonly version: 1;
  /** The machine the window shows now. */
  current(): string;
  show(machine: string, sessionId?: string): void;
  /** Open these machines' pages hidden, so that switching to them is instant. */
  prefetch(machines: readonly string[]): void;
  /** A framed page is up: called from inside the frame with its own window. */
  register(win: Window, handle: FrameHandle): () => void;
  subscribe(listener: () => void): () => void;
}

/** The shell of the window this page is framed in, if any (only a same-origin parent running this plugin). */
export function parentShell(): Shell | undefined {
  try {
    if (window.parent === window) return undefined;
    const shell = (window.parent as unknown as Record<string, Shell | undefined>)[KEY];
    return shell?.version === 1 ? shell : undefined;
  } catch { return undefined; }
}

/** The shell this page installed, when it is the window's own page. */
export const ownShell = (): Shell | undefined => {
  const shell = (window as unknown as Record<string, Shell | undefined>)[KEY];
  return shell?.version === 1 ? shell : undefined;
};

/** The shell that switches for this page: its own, or its parent's. */
export const shell = (): Shell | undefined => ownShell() ?? parentShell();

/**
 * How the window's page reached its DSH. Over HTTP/1.1 a browser opens at most six connections to one host, and every
 * DSH page holds about four open (plugin events, progress updates, this plugin's board…): a second page in a frame
 * leaves nothing for requests, and both pages stall. HTTP/2 (the phone through HTTPS) and the desktop app's own scheme
 * have no such limit.
 */
export function windowProtocol(): string {
  try {
    const top = window.top ?? window;
    return (top.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.nextHopProtocol ?? '';
  } catch { return ''; }
}
export const limitedConnections = () => windowProtocol() === 'http/1.1';

/** Whether switching keeps pages open (per browser): on unless turned off, and off by default over HTTP/1.1. */
export function keepPages(): boolean {
  try {
    const chosen = rawStorage().getItem(MODE);
    return chosen === 'on' || (chosen !== 'off' && !limitedConnections());
  } catch { return !limitedConnections(); }
}
export function setKeepPages(on: boolean): void {
  try { rawStorage().setItem(MODE, on ? 'on' : 'off'); } catch { /* not kept */ }
}

/** The conversation a machine's page shows (or restores at its next boot): this host's page keeps it unprefixed. */
export function currentSessionOf(machine: string): string {
  try {
    const raw = rawStorage();
    const prefix = machine === 'self' ? '' : storagePrefix(machine);
    return currentSession({ getItem: key => raw.getItem(prefix + key) });
  } catch { return ''; }
}

interface Frame {
  machine: string;
  iframe: HTMLIFrameElement;
  /** When the frame was made, for the report of how long its page took. */
  since: number;
  handle?: FrameHandle;
  /** The document that registered `handle`: a page that reloaded by itself (after a restart) registers again. */
  doc?: Document;
  /** A conversation to open once the page is up. */
  pending?: string;
  hint?: ReturnType<typeof setTimeout>;
  note?: HTMLElement;
}

export interface ShellDeps {
  /** The board's key for the machine this window's own page shows. */
  home: string;
  /** Open a conversation on the window's own page. */
  openOwn(sessionId: string): void;
  name(machine: string): string;
  hintText(name: string): { text: string; action: string };
  /** Machines that may be restored at a reload (known and online). */
  restorable(machine: string): boolean;
}

const urlOf = (machine: string) => machine === 'self' ? '/' : `${mountPrefix(machine)}/`;

/** Install the shell on the window's own page. */
export function installShell(deps: ShellDeps): { shell: Shell; restore(): void; dispose(): void } {
  const { home } = deps;
  const frames = new Map<string, Frame>();
  const listeners = new Set<() => void>();
  let current = home;
  // Back on this computer's own page: the next machine picked opens in a frame again. A machine opened directly keeps
  // its flag while it is the window's page, so that reloading it does not send it back into a frame.
  if (home === 'self') { try { sessionStorage.removeItem(SHELL_KEYS.direct); } catch { /* none */ } }
  const layer = document.createElement('div');
  layer.className = 'dl-frames';
  layer.hidden = true;
  // In the desktop window: a see-through title strip over the frames holds the window buttons, moves the window, and
  // names the machine shown. The frames' pages are not desktop pages; each fills the window and starts below the strip
  // (injectFrameTop), so its wallpaper shows behind the strip (styles.ts).
  const bar = document.createElement('div');
  bar.className = 'dl-frames-bar';
  bar.setAttribute('aria-hidden', 'true');
  layer.appendChild(bar);
  document.body.appendChild(layer);

  const changed = () => {
    try { sessionStorage.setItem(SHOWN, current); } catch { /* not kept */ }
    for (const listener of [...listeners]) { try { listener(); } catch { /* a listener's problem */ } }
  };

  const live = (frame: Frame): FrameHandle | undefined => {
    try { return frame.handle && frame.iframe.contentDocument === frame.doc ? frame.handle : undefined; } catch { return undefined; }
  };
  const clearHint = (frame: Frame) => { clearTimeout(frame.hint); frame.hint = undefined; frame.note?.remove(); frame.note = undefined; };
  const offerDirect = (frame: Frame) => {
    if (live(frame) || frame.note || !frames.has(frame.machine)) return;
    report('frame-slow', { machine: frame.machine, ms: Date.now() - frame.since });
    const { text, action } = deps.hintText(deps.name(frame.machine));
    const note = document.createElement('div');
    note.className = 'dl-frame-note';
    note.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = text;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action;
    button.addEventListener('click', () => {
      // That machine's page then stays the window's page instead of coming back here.
      try { sessionStorage.setItem(SHELL_KEYS.direct, frame.machine); } catch { /* it comes back once */ }
      location.assign(urlOf(frame.machine));
    });
    note.append(label, button);
    frame.note = note;
    layer.appendChild(note);
    note.hidden = current !== frame.machine;
  };

  const remove = (frame: Frame) => {
    clearHint(frame);
    frame.iframe.remove();
    frames.delete(frame.machine);
  };

  const reveal = () => {
    for (const frame of frames.values()) {
      const shown = frame.machine === current;
      frame.iframe.classList.toggle('dl-frame-shown', shown);
      frame.iframe.setAttribute('aria-hidden', String(!shown));
      if (shown) frame.iframe.removeAttribute('tabindex'); else frame.iframe.setAttribute('tabindex', '-1');
      if (frame.note) frame.note.hidden = !shown;
    }
    layer.hidden = current === home;
    if (current !== home) bar.textContent = deps.name(current);
  };

  const focusShown = () => {
    const frame = frames.get(current);
    try {
      if (frame) { frame.iframe.focus(); frame.iframe.contentWindow?.focus(); }
      else { (document.activeElement as HTMLElement | null)?.blur?.(); window.focus(); }
    } catch { /* focus is a nicety */ }
  };

  /** A frame navigated by itself, e.g. an older version of this plugin on that machine switching the way it used to. */
  const followed = (frame: Frame) => {
    let path: string;
    try { path = frame.iframe.contentWindow?.location.pathname ?? ''; } catch { return; }
    if (!path || path === 'blank') return;
    const now = mountedId(path) ?? 'self';
    if (now === frame.machine) return;
    const wasShown = current === frame.machine;
    if (now === 'self' || now === home || frames.has(now)) {
      remove(frame);
      if (wasShown) show(now);
      return;
    }
    // Now another machine's page: keep it as that machine's frame.
    frames.delete(frame.machine);
    frame.machine = now;
    frame.iframe.title = deps.name(now);
    frames.set(now, frame);
    if (wasShown) { current = now; reveal(); changed(); }
  };

  /** Load a machine's page again, in its frame: the window and the other machines' pages stay as they are. */
  const reloadFrame = (frame: Frame) => {
    report('frame-reload', { machine: frame.machine });
    clearHint(frame);
    frame.handle = undefined; frame.doc = undefined; frame.since = Date.now();
    frame.hint = setTimeout(() => offerDirect(frame), HINT_MS);
    try { frame.iframe.contentWindow!.location.reload(); } catch { frame.iframe.src = urlOf(frame.machine); }
  };
  /** ⌘R in a machine's page reloads that page; see isReloadKey. Each document the frame loads is a new window to listen on. */
  const watchKeys = (frame: Frame) => {
    let win: Window | null;
    try { win = frame.iframe.contentWindow; if (!win?.document) return; } catch { return; }
    win.addEventListener('keydown', event => {
      if (event.defaultPrevented || !isReloadKey(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      reloadFrame(frame);
    }, true);
  };

  const create = (machine: string, sessionId?: string): Frame => {
    if (sessionId) { try { selectSession(rawStorage(), machine === 'self' ? '' : machine, sessionId); } catch { /* opens where it was */ } }
    const iframe = document.createElement('iframe');
    iframe.className = 'dl-frame';
    iframe.title = deps.name(machine);
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen; microphone; camera; display-capture');
    // Set before it is attached, so the first load adds no history entry.
    iframe.src = urlOf(machine);
    const frame: Frame = { machine, iframe, since: Date.now() };
    iframe.addEventListener('load', () => {
      watchKeys(frame);
      followed(frame);
      if (!live(frame) && frames.get(frame.machine) === frame) {
        clearTimeout(frame.hint);
        frame.hint = setTimeout(() => offerDirect(frame), HINT_AFTER_LOAD_MS);
      }
    });
    frames.set(machine, frame);
    layer.appendChild(iframe);
    frame.hint = setTimeout(() => offerDirect(frame), HINT_MS);
    return frame;
  };

  function show(machine: string, sessionId?: string): void {
    if (machine === home) {
      current = home;
      reveal(); focusShown(); changed();
      if (sessionId) deps.openOwn(sessionId);
      return;
    }
    // This window's page shows another machine (it was opened by its address); its own host's page loads as a page.
    if (machine === 'self') {
      if (sessionId) { try { selectSession(rawStorage(), '', sessionId); } catch { /* opens where it was */ } }
      location.assign('/');
      return;
    }
    let frame = frames.get(machine);
    if (!frame) frame = create(machine, sessionId);
    else if (sessionId) {
      const handle = live(frame);
      if (handle) { try { handle.openSession(sessionId); } catch { frame.pending = sessionId; } }
      else {
        // The page is still coming up: it restores this at boot, or opens it when it registers.
        try { selectSession(rawStorage(), machine, sessionId); } catch { /* opens it at registration */ }
        frame.pending = sessionId;
      }
    }
    current = machine;
    reveal(); focusShown(); changed();
  }

  const shell: Shell = {
    version: 1,
    current: () => current,
    show,
    prefetch(machines) {
      for (const machine of machines) if (machine !== home && machine !== 'self' && !frames.has(machine)) create(machine);
      reveal();
    },
    register(win, handle) {
      const frame = [...frames.values()].find(entry => entry.iframe.contentWindow === win);
      if (!frame) return () => {};
      if (!frame.handle) report('frame-up', { machine: frame.machine, ms: Date.now() - frame.since, shown: frame.machine === current });
      frame.handle = handle;
      frame.doc = win.document;
      clearHint(frame);
      const pending = frame.pending;
      frame.pending = undefined;
      if (pending) { try { handle.openSession(pending); } catch { /* the page restores its own */ } }
      return () => { if (frame.handle === handle) { frame.handle = undefined; frame.doc = undefined; } };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  (window as unknown as Record<string, Shell>)[KEY] = shell;

  return {
    shell,
    restore() {
      let saved: string | null = null;
      try { saved = sessionStorage.getItem(SHOWN); } catch { /* none */ }
      if (saved && saved !== home && saved !== 'self' && current === home && deps.restorable(saved)) show(saved);
    },
    dispose() {
      for (const frame of [...frames.values()]) remove(frame);
      layer.remove();
      if ((window as unknown as Record<string, Shell | undefined>)[KEY] === shell) delete (window as unknown as Record<string, Shell | undefined>)[KEY];
    },
  };
}
