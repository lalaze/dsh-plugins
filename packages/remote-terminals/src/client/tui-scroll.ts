import { useEffect } from 'react';
import { lookForXterm } from './tui-render.js';

const SAVED_KEY = 'remote-agents.tui.local-scroll';
/**
 * Lines a TUI's terminal keeps to scroll back through. DSH's 1000 are for a shell; here they hold the conversation, which
 * the CLI prints whole when it resumes. A full buffer of 126 columns takes about 15 MB.
 */
export const TUI_SCROLLBACK = 10_000;

interface ChoiceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const browserStorage = (): ChoiceStorage | undefined => { try { return localStorage; } catch { return undefined; } };

/**
 * Whether Claude Code leaves scrolling to the terminal (its classic renderer) or draws it itself (fullscreen); see
 * TuiSessions.localScroll on the server, which keeps the choice because the launcher reads it. Kept here too, so that the
 * switch shows the right way before the server has answered.
 */
export class TuiScrollChoice {
  private local: boolean;
  private changed = false;
  private readonly listeners = new Set<() => void>();
  /** @param save - stores the choice on the server. */
  constructor(private readonly save: (local: boolean) => Promise<unknown>, private readonly storage = browserStorage()) {
    let saved: string | null | undefined;
    try { saved = storage?.getItem(SAVED_KEY); } catch { /* the default until the server answers */ }
    this.local = saved !== 'false';
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.local;
  /** The server's choice, which another page may have changed. */
  load(local: boolean): void { this.apply(local); }
  /** Changes it. A CLI already running keeps the renderer it started with. */
  set(local: boolean): void {
    const before = this.local;
    if (local === before) return;
    this.changed = true;
    this.apply(local);
    // Not saved means the next CLI would start the old way, so the switch goes back to say so.
    this.save(local).catch(() => { if (this.local === local) this.apply(before); });
  }
  /**
   * Whether a Claude Code is still running the other way, and so has to restart for the choice to apply.
   * @param buffer - the buffer its terminal shows: fullscreen draws on the alternate one.
   */
  stale(buffer: string | undefined): boolean {
    if (this.local) return buffer === 'alternate';
    // The normal buffer is also a shell, or a CLI about to switch: only worth saying after the switch was just turned off.
    return this.changed && buffer === 'normal';
  }
  private apply(local: boolean): void {
    if (this.local === local) return;
    this.local = local;
    try { this.storage?.setItem(SAVED_KEY, String(local)); } catch { /* it still applies until the page reloads */ }
    for (const listener of this.listeners) listener();
  }
}

/** Gives a TUI's terminal room for a conversation; see TUI_SCROLLBACK. */
export function useConversationScrollback(host: HTMLElement): void {
  useEffect(() => lookForXterm(host, xterm => { if (!((xterm.options.scrollback ?? 0) >= TUI_SCROLLBACK)) xterm.options.scrollback = TUI_SCROLLBACK; }), [host]);
}
