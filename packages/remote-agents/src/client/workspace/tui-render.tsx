import { WebglAddon } from '@xterm/addon-webgl';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { localizeError, ui, useLocale } from '../i18n.js';
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
export type WebglIssue = 'unavailable' | 'lost';

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
  options: { theme?: { background?: string } & Record<string, unknown>; scrollback?: number };
  modes: { mouseTrackingMode: string };
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

/**
 * Draws one terminal with WebGL while that is switched on. Only once it has been shown, as a terminal out of view has no size
 * to draw at; it then stays, because building the glyph atlas is the slow part.
 * @param host - the element around the terminal.
 * @param visible - whether the terminal is on screen.
 * @param theme - the current theme, as a new one makes DSH set the terminal's colors again.
 */
export function useWebglRenderer(host: HTMLElement, visible: boolean, choices: TuiRenderChoices, theme: unknown): void {
  const { webgl } = useSyncExternalStore(choices.subscribe, choices.snapshot);
  const active = useRef<{ xterm: Xterm; addon: WebglAddon; background?: string }>();
  const unload = () => {
    const current = active.current;
    if (!current) return;
    active.current = undefined;
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
    if (!webgl) { unload(); return; }
    if (!visible || active.current) return;
    const load = (xterm: Xterm) => {
      try {
        const addon = new WebglAddon();
        xterm.loadAddon(addon);
        active.current = { xterm, addon };
        // Back to the page's own drawing, which always works. Coming back into view tries again.
        addon.onContextLoss(() => { unload(); choices.report('lost'); });
        clearPaint();
        refit(xterm);
        choices.report(undefined);
      } catch { choices.report('unavailable'); }
    };
    return lookForXterm(host, load, () => choices.report('unavailable'));
  }, [webgl, visible, host]);
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
      {webgl && issue && <div className="ra-tui-render-issue" role="alert">{ui(issue === 'lost' ? 'WebGL stopped working here, so the standard rendering is back.' : 'WebGL is not available here, so the standard rendering stays.')}</div>}
    </div>}
  </div>;
}
