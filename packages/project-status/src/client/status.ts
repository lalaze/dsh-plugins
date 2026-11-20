/**
 * The status of each conversation's project, read once for everything on the page that shows it: the Status view and the
 * mark on its tab. Nothing is pushed to a page, so it is asked for again every few seconds while something shows it and
 * the page is visible, and at once when the window gets the focus back.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { StatusAnswer } from '../domain.js';
import { readStatus, StatusRequestError } from './api.js';

/** With the view open an agent's edit should show soon; the tab's mark alone can wait. */
const FAST_MS = 4000, SLOW_MS = 15_000;
export type Pace = 'fast' | 'slow';
export interface Snapshot { answer?: StatusAnswer; error?: string; status?: number }

interface Entry { snapshot: Snapshot; key: string; listeners: Set<() => void>; fast: number; slow: number; timer?: ReturnType<typeof setInterval>; period?: number; loading?: Promise<void>; puts: number }
const entries = new Map<string, Entry>(), EMPTY: Snapshot = {};
const entryOf = (sessionId: string) => {
  let entry = entries.get(sessionId);
  if (!entry) entries.set(sessionId, entry = { snapshot: EMPTY, key: '', listeners: new Set(), fast: 0, slow: 0, puts: 0 });
  return entry;
};
const set = (entry: Entry, snapshot: Snapshot) => {
  // Most answers repeat the last one; a view that is being typed in should not render for those.
  const key = JSON.stringify(snapshot);
  if (key === entry.key) return;
  entry.key = key; entry.snapshot = snapshot;
  for (const listener of [...entry.listeners]) listener();
};

/** Asks the host now. One request per conversation at a time. */
export function refresh(sessionId: string): Promise<void> {
  const entry = entryOf(sessionId), puts = entry.puts;
  return entry.loading ??= readStatus(sessionId).then(
    // An answer that was on its way while a save came back is older than what the save said.
    answer => { if (entry.puts === puts) set(entry, { answer }); },
    (error: unknown) => { set(entry, { ...(entry.snapshot.answer ? { answer: entry.snapshot.answer } : {}), error: error instanceof Error ? error.message : String(error), ...(error instanceof StatusRequestError ? { status: error.status } : {}) }); },
  ).finally(() => { entry.loading = undefined; });
}
/** What a save answered is the status now. */
export const put = (sessionId: string, answer: StatusAnswer) => { const entry = entryOf(sessionId); entry.puts++; set(entry, { answer }); };

const awake = () => { if (!document.hidden) for (const [sessionId, entry] of entries) if (entry.fast + entry.slow > 0) void refresh(sessionId); };
let watching = false;
function watch(): void {
  const wanted = [...entries.values()].some(entry => entry.fast + entry.slow > 0);
  if (wanted === watching || typeof window === 'undefined') return;
  watching = wanted;
  if (wanted) { window.addEventListener('focus', awake); document.addEventListener('visibilitychange', awake); }
  else { window.removeEventListener('focus', awake); document.removeEventListener('visibilitychange', awake); }
}
function pace(sessionId: string, entry: Entry): void {
  const period = entry.fast > 0 ? FAST_MS : entry.slow > 0 ? SLOW_MS : undefined;
  if (period !== entry.period) {
    if (entry.timer !== undefined) clearInterval(entry.timer);
    entry.period = period;
    entry.timer = period === undefined ? undefined : setInterval(() => { if (!document.hidden) void refresh(sessionId); }, period);
  }
  watch();
}

/** The status of a conversation's project, kept current for as long as the component is mounted. */
export function useStatus(sessionId: string | undefined, speed: Pace): Snapshot {
  useEffect(() => {
    if (!sessionId) return;
    const entry = entryOf(sessionId);
    entry[speed]++;
    pace(sessionId, entry);
    void refresh(sessionId);
    return () => { entry[speed]--; pace(sessionId, entry); };
  }, [sessionId, speed]);
  return useSyncExternalStore(
    listener => {
      if (!sessionId) return () => {};
      const entry = entryOf(sessionId);
      entry.listeners.add(listener);
      return () => { entry.listeners.delete(listener); };
    },
    () => sessionId ? entryOf(sessionId).snapshot : EMPTY, () => EMPTY);
}
/** For tests: forgets every conversation and stops asking. */
export function resetStatus(): void {
  for (const entry of entries.values()) if (entry.timer !== undefined) clearInterval(entry.timer);
  entries.clear();
  watch();
}
