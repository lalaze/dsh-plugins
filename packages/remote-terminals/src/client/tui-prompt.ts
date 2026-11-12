import { useEffect, useSyncExternalStore } from 'react';
import { pasteIntoTerminal, whenWritable } from './tui-files.js';
import { findXterm } from './tui-render.js';

/** How long text waits for a terminal. One that is not open yet starts its launcher and attaches first. */
const WAIT_MS = 10_000;
interface Waiting { readonly text: string; taken(): void }
const NONE: readonly Waiting[] = [];

/**
 * Text that other plugins want typed at a TUI conversation's prompt, where a chat would have its composer. Held outside
 * the terminal, as the conversation may be on another tab, or not opened at all, when the text is offered.
 */
export class TuiPrompts {
  private readonly lists = new Map<string, readonly Waiting[]>();
  private readonly listeners = new Set<() => void>();
  /** @param waitMs - how long text waits for the terminal before it is withdrawn. */
  constructor(private readonly waitMs = WAIT_MS) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  /** What waits for a conversation's terminal. The same object until it changes, as React compares them. */
  waiting = (sessionId: string): readonly Waiting[] => this.lists.get(sessionId) ?? NONE;
  private set(sessionId: string, list: readonly Waiting[]): void {
    if (list.length) this.lists.set(sessionId, list); else this.lists.delete(sessionId);
    for (const listener of [...this.listeners]) listener();
  }
  /** @returns whether the terminal took the text. Text nothing took in time is withdrawn, so it cannot turn up later unasked. */
  add(sessionId: string, text: string): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.set(sessionId, this.waiting(sessionId).filter(other => other !== entry)); resolve(false); }, this.waitMs);
      const entry: Waiting = { text, taken: () => { clearTimeout(timer); resolve(true); } };
      this.set(sessionId, [...this.waiting(sessionId), entry]);
    });
  }
  /** The waiting text in the order it came, each handed over once. */
  take(sessionId: string): string[] {
    const list = this.waiting(sessionId);
    if (list.length) this.set(sessionId, NONE);
    for (const entry of list) entry.taken();
    return list.map(entry => entry.text);
  }
}

/**
 * What to paste so that the text only sits at the prompt. A terminal turns each line break of a paste into Enter, and
 * only an app that asked for bracketed paste knows those belong to a paste. For any other, the text goes on one line,
 * or its first line would be sent.
 */
export function promptPaste(text: string, bracketed: boolean): string {
  const trimmed = text.replace(/\s+$/, '');
  return bracketed ? trimmed : trimmed.replace(/\s*\n\s*/g, ' ');
}

/**
 * Types the waiting text into the terminal, once it can take input.
 * @param root - an element around the terminal.
 * @param terminal - DSH's terminal state.
 */
export function usePromptText(root: React.RefObject<HTMLElement | null>, sessionId: string, prompts: TuiPrompts, terminal: { getSnapshot(): { writable?: boolean } }): void {
  const waiting = useSyncExternalStore(prompts.subscribe, () => prompts.waiting(sessionId));
  useEffect(() => {
    if (!waiting.length) return;
    return whenWritable(root, terminal, input => {
      const bracketed = !!root.current && findXterm(root.current)?.modes.bracketedPasteMode === true;
      for (const text of prompts.take(sessionId)) pasteIntoTerminal(input, promptPaste(text, bracketed));
    });
  }, [root, sessionId, prompts, terminal, waiting]);
}
