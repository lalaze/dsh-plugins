import { WebglAddon } from '@xterm/addon-webgl';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { localizeError, ui, useLocale } from './i18n.js';
import type { TuiScrollChoice } from './tui-scroll.js';

const SAVED_KEY = 'remote-agents.tui.render';
/** How often to look for a terminal that is not there yet, as DSH's terminal code loads late, and for how long. */
const LOOK_MS = 100, LOOK_LIMIT_MS = 15_000;

export interface RenderChoices { webgl: boolean; blur: boolean }
/**
 * WebGL unless it is switched off. Claude Code's echo of one key moves the cursor to the top of the screen and back, so
 * xterm takes every row as changed and the page's own renderer builds them all again: measured on DSH 0.2.2-rc.1 at 113x50,
 * a key took a median of 44 ms to show against 26 ms with WebGL, and about 11.5 ms of the page's main thread against 2 ms.
 */
const DEFAULTS: RenderChoices = { webgl: true, blur: true };
/**
 * Marks a value saved since WebGL became the default. Until then turning either switch saved `webgl: false` along with it,
 * so in an older value "off" need not be anyone's choice and the default applies; "on" always was one.
 */
const SAVED_VERSION = 2;
export type WebglIssue = 'unavailable' | 'lost' | 'scaled';

interface ChoiceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const browserStorage = (): ChoiceStorage | undefined => { try { return localStorage; } catch { return undefined; } };

/** The render switches of this browser, which apply to every TUI at once. */
export class TuiRenderChoices {
  private choices: RenderChoices;
  private problem?: WebglIssue;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage = browserStorage()) {
    let saved: Partial<RenderChoices> & { version?: number } = {};
    try { saved = JSON.parse(storage?.getItem(SAVED_KEY) ?? '{}') as typeof saved; } catch { /* a damaged value just means the defaults */ }
    const webgl = saved.webgl === true || saved.version === SAVED_VERSION ? saved.webgl : undefined;
    this.choices = { webgl: webgl ?? DEFAULTS.webgl, blur: saved.blur ?? DEFAULTS.blur };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.choices;
  /** Why WebGL is not drawing though it was asked to. */
  issue = () => this.problem;
  set(change: Partial<RenderChoices>): void {
    this.choices = { ...this.choices, ...change };
    if (change.webgl !== undefined) this.problem = undefined;
    try { this.storage?.setItem(SAVED_KEY, JSON.stringify({ ...this.choices, version: SAVED_VERSION })); } catch { /* it still applies until the page reloads */ }
    this.notify();
  }
  report(problem: WebglIssue | undefined): void {
    if (this.problem === problem) return;
    this.problem = problem;
    this.notify();
  }
  private notify() { for (const listener of this.listeners) listener(); }
}

/** The part of xterm's terminal this uses. */
export interface Xterm {
  loadAddon(addon: unknown): void;
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
  /** Sends data as if the terminal had: it reaches DSH, and the CLI, like a key. */
  input?(data: string, wasUserInput?: boolean): void;
  options: { theme?: { background?: string } & Record<string, unknown>; scrollback?: number };
  modes: { mouseTrackingMode: string; bracketedPasteMode?: boolean; sendFocusMode?: boolean };
  buffer: { active: { type: string } };
  parser: {
    registerOscHandler(ident: number, handler: (data: string) => boolean): { dispose(): void };
    registerCsiHandler(id: { prefix?: string; final: string }, handler: (params: Array<number | number[]>) => boolean): { dispose(): void };
  };
}
interface Fiber { return?: Fiber | null; memoizedState?: unknown }
interface Hook { memoizedState?: unknown; next?: Hook | null }
/** How far above the terminal's own element its component may be: that element is the first thing it renders. */
const FIBER_LEVELS = 4;

/**
 * The xterm inside DSH's terminal, which keeps it in a ref of its screen component and offers no way to reach it. This finds
 * that ref by what it holds, through what React stores on the element xterm opened in.
 * @param container - an element holding a terminal, or the terminal's own.
 * @returns undefined if there is no terminal yet, or DSH came to keep it elsewhere: then nothing here can act on it.
 */
export function findXterm(container: Element): Xterm | undefined {
  const opened = (container.matches('.xterm') ? container : container.querySelector('.xterm'))?.parentElement;
  if (!opened) return undefined;
  const key = Object.keys(opened).find(name => name.startsWith('__reactFiber$'));
  let fiber = key ? (opened as unknown as Record<string, Fiber | null | undefined>)[key] : undefined;
  for (let level = 0; fiber && level < FIBER_LEVELS; level += 1, fiber = fiber.return) {
    let hook = fiber.memoizedState as Hook | null | undefined;
    // A component's state starts its list of hooks, while other kinds of element keep something else there.
    while (hook && typeof hook === 'object' && 'next' in hook) {
      const value = (hook.memoizedState as { current?: Partial<Xterm> } | null | undefined)?.current;
      if (typeof value?.loadAddon === 'function') return value as Xterm;
      hook = hook.next;
    }
  }
  return undefined;
}

/**
 * Waits for the terminal in an element, as DSH's terminal code loads late.
 * @param found - called once with the terminal, at once if it is already there.
 * @param missing - called if it never comes.
 * @returns stops waiting.
 */
export function lookForXterm(host: Element, found: (xterm: Xterm) => void, missing?: () => void): () => void {
  const present = findXterm(host);
  if (present) { found(present); return () => {}; }
  const until = Date.now() + LOOK_LIMIT_MS;
  const timer = setInterval(() => {
    const xterm = findXterm(host);
    if (xterm) found(xterm);
    else if (Date.now() > until) missing?.();
    else return;
    clearInterval(timer);
  }, LOOK_MS);
  return () => clearInterval(timer);
}

/**
 * The theme's background with nothing to paint. The TUI's translucent background is on the terminal's parent, and WebGL paints
 * the theme's over it, which would nearly hide the wallpaper inside the text area alone. Its color stays, for text contrast.
 */
export function withoutPaint(background: string | undefined): string | undefined {
  const color = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/.exec(background ?? '');
  return color ? `rgba(${color[1]}, ${color[2]}, ${color[3]}, 0)` : undefined;
}

/**
 * The cell size changes with the renderer, as WebGL works in whole device pixels. DSH fits the terminal when its element
 * resizes, so resize it for a frame. Putting it back takes a second one: a frame's animation callbacks run before it checks
 * for resizes, so restoring in the first would leave nothing to see.
 */
function refit(xterm: Xterm): void {
  const node = xterm.element?.parentElement;
  if (!node) return;
  node.style.width = 'calc(100% - 1px)';
  requestAnimationFrame(() => requestAnimationFrame(() => { node.style.width = ''; }));
}

/** How far an element's device pixels may be from its size times `devicePixelRatio`: snapping to whole pixels stays well inside. */
const SCALE_TOLERANCE = 0.03;
/** Narrower than this, a pixel of snapping is too much of the width to tell anything from. */
const SCALE_MIN_WIDTH = 32;
/**
 * Whether the browser emulates the screen's pixel ratio, as Chrome's device mode does: an element's real device pixels and
 * `devicePixelRatio` then disagree. xterm's WebGL sizes its canvas by the first and draws by the second, so the text comes
 * out larger or smaller than the canvas and only its lower left corner shows (seen 2026-11-15 as an iPhone SE at 2x in
 * device mode on a 1x display: text over twice its size, cut off on the right).
 * @param width - the element's width in CSS pixels.
 * @param device - its width in device pixels.
 * @returns undefined when the element is too small to tell, as one out of view is.
 */
export function emulatedScale(width: number, device: number, ratio: number): boolean | undefined {
  if (!(width >= SCALE_MIN_WIDTH) || !(device > 0) || !(ratio > 0)) return undefined;
  return Math.abs(device / (width * ratio) - 1) > SCALE_TOLERANCE;
}

/** The part of xterm's WebGL addon that the atlas recovery uses. */
export interface AtlasDrawer {
  clearTextureAtlas(): void;
  readonly textureAtlas?: EventTarget;
  onChangeTextureAtlas(listener: (canvas: EventTarget) => void): { dispose(): void };
}

/**
 * The terminals drawn with WebGL on this page. They share xterm's glyph atlas, one for each font, size and set of colors,
 * whose pages are 2D canvases. Losing the GPU, as Android does to a page in the background, empties those canvases. When the
 * context comes back xterm builds its WebGL state again, but it takes the same atlas while another terminal still uses it,
 * and that atlas still lists every glyph it had drawn. Those glyphs then show blank and only glyphs drawn for the first time
 * afterwards appear: ASCII, rules and common characters were gone, rarer ones were there (seen 2026-11-17 on a phone,
 * reproduced in Chrome with xterm 6 and addon-webgl 0.19 by killing its GPU process with two terminals; one alone recovers).
 * Clearing the atlas through each terminal draws every glyph again. In that Chrome the atlas canvas came back about 0.6 s
 * before WebGL did, so either one coming back is the moment.
 */
export class GlyphAtlases {
  private readonly drawing = new Set<AtlasDrawer>();
  /**
   * A context went since the glyphs were last drawn again. A terminal that went back to the page's own drawing because its
   * context stayed away, and takes WebGL up again later, finds what is left of the atlas the others share.
   */
  private lost = false;
  /**
   * Follows a terminal from the moment it draws with WebGL.
   * @param canvases - the canvases WebGL draws on, whose context can go and come back.
   * @returns stops following it.
   */
  add(addon: AtlasDrawer, canvases: Iterable<EventTarget>): () => void {
    this.drawing.add(addon);
    const lost = () => { this.lost = true; };
    const back = () => this.redraw();
    const watched = new Map<EventTarget, [lost: string, back: string]>();
    const watch = (target: EventTarget | undefined, events: [lost: string, back: string]) => {
      if (!target || watched.has(target)) return;
      watched.set(target, events);
      // After xterm's own listeners, which it added when the addon loaded, have built its state again.
      target.addEventListener(events[0], lost);
      target.addEventListener(events[1], back);
    };
    for (const canvas of canvases) watch(canvas, ['webglcontextlost', 'webglcontextrestored']);
    const atlas = (canvas: EventTarget | undefined) => watch(canvas, ['contextlost', 'contextrestored']);
    const changes = addon.onChangeTextureAtlas(atlas);
    atlas(addon.textureAtlas);
    if (this.lost) this.redraw();
    return () => {
      this.drawing.delete(addon);
      changes.dispose();
      for (const [target, [gone, returned]] of watched) {
        target.removeEventListener(gone, lost);
        target.removeEventListener(returned, back);
      }
    };
  }
  /** Draws every glyph of every terminal again. */
  redraw(): void {
    this.lost = false;
    for (const addon of this.drawing) {
      try { addon.clearTextureAtlas(); } catch { /* a terminal being taken down draws nothing anyway */ }
    }
  }
}
const atlases = new GlyphAtlases();

type ScreenScale = 'unknown' | 'real' | 'emulated';
/** Whether the screen's scale is emulated where the terminal is, which is known once the terminal is shown with a size. */
function useScreenScale(host: HTMLElement, visible: boolean): ScreenScale {
  const [scale, setScale] = useState<ScreenScale>(typeof ResizeObserver === 'undefined' ? 'real' : 'unknown');
  useEffect(() => {
    if (!visible || typeof ResizeObserver === 'undefined') return;
    let observer: ResizeObserver | undefined;
    // The terminal's own element: the elements DSH and this plugin put around it are `display: contents`, with no size.
    const stop = lookForXterm(host, xterm => {
      if (!xterm.element) return;
      observer = new ResizeObserver(entries => {
        const entry = entries.at(-1);
        const width = entry?.contentBoxSize?.[0]?.inlineSize, device = entry?.devicePixelContentBoxSize?.[0]?.inlineSize;
        const result = width === undefined || device === undefined ? undefined : emulatedScale(width, device, window.devicePixelRatio);
        if (result !== undefined) setScale(result ? 'emulated' : 'real');
      });
      // Safari has no device pixel box. xterm then sizes its canvas by devicePixelRatio too, so the two cannot disagree.
      try { observer.observe(xterm.element, { box: 'device-pixel-content-box' }); } catch { observer.disconnect(); observer = undefined; setScale('real'); }
    });
    return () => { stop(); observer?.disconnect(); };
  }, [host, visible]);
  return scale;
}

/**
 * Draws one terminal with WebGL while that is switched on and the screen's scale is known to be real. Only once it has been
 * shown, as a terminal out of view has no size to draw at; it then stays, because building the glyph atlas is the slow part.
 * @param host - the element around the terminal.
 * @param visible - whether the terminal is on screen.
 * @param theme - the current theme, as a new one makes DSH set the terminal's colors again.
 */
export function useWebglRenderer(host: HTMLElement, visible: boolean, choices: TuiRenderChoices, theme: unknown): void {
  const { webgl: chosen } = useSyncExternalStore(choices.subscribe, choices.snapshot);
  const scale = useScreenScale(host, visible), webgl = chosen && scale === 'real';
  const active = useRef<{ xterm: Xterm; addon: WebglAddon; background?: string; unwatch(): void }>();
  const unload = () => {
    const current = active.current;
    if (!current) return;
    active.current = undefined;
    current.unwatch();
    current.addon.dispose();
    const { theme: colors } = current.xterm.options;
    if (colors && current.background !== undefined) current.xterm.options.theme = { ...colors, background: current.background };
    refit(current.xterm);
  };
  const clearPaint = () => {
    const current = active.current;
    const colors = current?.xterm.options.theme, clear = withoutPaint(colors?.background);
    if (!current || !colors || clear === undefined || clear === colors.background) return;
    current.background = colors.background;
    current.xterm.options.theme = { ...colors, background: clear };
  };
  useEffect(() => {
    if (!webgl) { unload(); if (chosen && scale === 'emulated') choices.report('scaled'); return; }
    if (!visible || active.current) return;
    const load = (xterm: Xterm) => {
      try {
        const addon = new WebglAddon();
        xterm.loadAddon(addon);
        const unwatch = atlases.add(addon as unknown as AtlasDrawer, xterm.element?.querySelectorAll('canvas') ?? []);
        active.current = { xterm, addon, unwatch };
        // Back to the page's own drawing, which always works. Coming back into view tries again.
        addon.onContextLoss(() => { unload(); choices.report('lost'); });
        clearPaint();
        refit(xterm);
        choices.report(undefined);
      } catch { choices.report('unavailable'); }
    };
    return lookForXterm(host, load, () => choices.report('unavailable'));
  }, [webgl, chosen, scale, visible, host]);
  // After DSH's own effect for the same theme, which ran during the commit.
  useEffect(clearPaint, [theme]);
  useEffect(() => unload, []);
}

const styles = `.ra-tui-render{position:absolute;right:3px;bottom:3px;z-index:2}
.ra-tui-render-button{display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#888);opacity:.55;cursor:pointer}
.ra-tui-render-button:hover,.ra-tui-render-button[aria-expanded="true"]{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ra-tui-render-menu{position:absolute;right:0;bottom:26px;box-sizing:border-box;width:240px;padding:6px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,#26272b);color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-elevation-prominent,0 0 0 1px rgba(127,127,127,.25),0 8px 24px rgba(0,0,0,.3));font-size:13px;line-height:18px}
.ra-tui-render-row{display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ra-tui-render-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ra-tui-render-track{flex:none;position:relative;width:26px;height:16px;border-radius:8px;background:rgba(127,127,127,.4);transition:background .12s}
.ra-tui-render-track::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .12s}
[aria-checked="true"]>.ra-tui-render-track{background:var(--dsw-alias-state-business-primary,#4d6bfe)}
[aria-checked="true"]>.ra-tui-render-track::after{transform:translateX(10px)}
.ra-tui-render-issue{padding:4px 8px 2px;color:var(--dsw-alias-state-error-primary,#d64545);font-size:12px}
.ra-tui-render-note{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:2px 8px 6px;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}
.ra-tui-render-act{padding:3px 8px;border:1px solid rgba(127,127,127,.4);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary,#eee);font:inherit;cursor:pointer}
.ra-tui-render-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ra-tui-render-act:disabled{cursor:default;opacity:.5}`;

function Switch({ label, hint, on, change }: { label: string; hint?: string; on: boolean; change(on: boolean): void }) {
  return <button type="button" role="switch" aria-checked={on} className="ra-tui-render-row" title={hint} onClick={() => change(!on)}>
    <span>{label}</span><span className="ra-tui-render-track" />
  </button>;
}

/** The scrolling switch of a Claude Code conversation, and what it takes to apply it to the CLI already running there. */
export interface TuiScrollControl {
  choice: TuiScrollChoice;
  /** The buffer the conversation's terminal shows now, if it has a terminal. */
  buffer(): string | undefined;
  /** Whether the CLI is in a turn, which restarting it would stop. */
  running(): boolean;
  /** Ends the CLI and starts it again in the same conversation. */
  restart(): Promise<void>;
}
const ISSUES: Record<WebglIssue, string> = {
  lost: 'WebGL stopped working here, so the standard rendering is back.',
  unavailable: 'WebGL is not available here, so the standard rendering stays.',
  scaled: 'The browser is emulating this screen\'s scale, as in device mode, which WebGL draws wrong, so the standard rendering is used.',
};
/** How often to look at the terminal and its turn while the menu is open: a restarted CLI takes a moment to show which buffer it uses. */
const BUFFER_CHECK_MS = 500;

function ScrollRows({ scroll }: { scroll: TuiScrollControl }) {
  const local = useSyncExternalStore(scroll.choice.subscribe, scroll.choice.snapshot);
  const [buffer, setBuffer] = useState(scroll.buffer), [running, setRunning] = useState(scroll.running);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => { setBuffer(scroll.buffer()); setRunning(scroll.running()); }, BUFFER_CHECK_MS);
    return () => clearInterval(timer);
  }, [scroll]);
  const restart = () => {
    setBusy(true); setError('');
    scroll.restart().catch(cause => setError(localizeError(cause instanceof Error ? cause.message : String(cause)))).finally(() => setBusy(false));
  };
  return <>
    <Switch label={ui('Local scrolling')} hint={ui('The terminal scrolls the conversation itself instead of asking Claude Code over the network. Claude Code\'s fullscreen features, such as clicking to expand, are off.')} on={local} change={value => scroll.choice.set(value)} />
    {scroll.choice.stale(buffer) && <div className="ra-tui-render-note">
      <span>{ui('Takes effect when Claude Code restarts.')}</span>
      <button type="button" className="ra-tui-render-act" disabled={busy} onClick={restart}>{ui(running ? 'Restart now and stop the current turn' : 'Restart now')}</button>
    </div>}
    {error && <div className="ra-tui-render-issue" role="alert">{error}</div>}
  </>;
}

/** The render switches, in the corner of a TUI conversation so the two ways can be compared while using it. */
/** @param scroll - given for a Claude Code conversation; Codex always scrolls in the terminal. */
export function TuiRenderMenu({ choices, scroll }: { choices: TuiRenderChoices; scroll?: TuiScrollControl }) {
  useLocale();
  const { webgl, blur } = useSyncExternalStore(choices.subscribe, choices.snapshot);
  const issue = useSyncExternalStore(choices.subscribe, choices.issue);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  // Not taking focus: the whole point is to go on typing in the terminal, and Esc there would interrupt the CLI.
  return <div ref={root} className="ra-tui-render" data-remote-agents-tui-render="" onMouseDown={event => event.preventDefault()}>
    <style>{styles}</style>
    <button type="button" className="ra-tui-render-button" aria-label={ui('Terminal rendering')} title={ui('Terminal rendering')} aria-expanded={open} onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <path d="M2 5h6M12 5h2M2 11h2M8 11h6" /><circle cx="10" cy="5" r="1.8" /><circle cx="6" cy="11" r="1.8" />
      </svg>
    </button>
    {open && <div className="ra-tui-render-menu" role="group" aria-label={ui('Terminal rendering')}>
      <Switch label={ui('WebGL rendering')} on={webgl} change={value => choices.set({ webgl: value })} />
      <Switch label={ui('Background blur')} on={blur} change={value => choices.set({ blur: value })} />
      {scroll && <ScrollRows scroll={scroll} />}
      {webgl && issue && <div className="ra-tui-render-issue" role="alert">{ui(ISSUES[issue])}</div>}
    </div>}
  </div>;
}
