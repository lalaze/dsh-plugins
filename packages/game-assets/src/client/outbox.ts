/**
 * Text on its way into a conversation's composer. DSH hands the draft setter only to components inside the composer,
 * so a hidden one waits there (see {@link ComposerBridge}) and takes what the Assets view offers.
 */
import { useEffect } from 'react';

interface Offer { text: string; taken(): void }
const offers = new Map<string, Offer>(), listeners = new Set<() => void>();
/** How long an offer waits for a composer to show up, for example while DSH switches back to Chat. */
const WAIT_MS = 2000;

/** Offers text to the composer of a conversation. Answers whether a composer took it; an offer nobody took is withdrawn. */
export function offer(sessionId: string, text: string): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { if (offers.get(sessionId) === entry) offers.delete(sessionId); resolve(false); }, WAIT_MS);
    const entry: Offer = { text, taken: () => { clearTimeout(timer); resolve(true); } };
    offers.set(sessionId, entry);
    for (const listener of [...listeners]) listener();
  });
}

/** The composer's side: props DSH gives a `conversation.input.left` entry. */
export interface ComposerProps {
  sessionId?: string;
  inputActions?: { setDraft(text: string): void };
  useInput?: <T>(select: (state: { draft: string }) => T) => T;
}
/** Renders nothing. Adds offered text after whatever the user already typed. */
export function ComposerBridge({ sessionId, inputActions, useInput }: ComposerProps) {
  const draft = useInput?.(state => state.draft) ?? '';
  useEffect(() => {
    if (!sessionId || !inputActions) return;
    const take = () => {
      const entry = offers.get(sessionId);
      if (!entry) return;
      offers.delete(sessionId);
      inputActions.setDraft(draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${entry.text}` : entry.text);
      entry.taken();
    };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, [sessionId, inputActions, draft]);
  return null;
}
