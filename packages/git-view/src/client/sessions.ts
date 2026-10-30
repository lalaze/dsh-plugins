import { useCallback, useSyncExternalStore } from 'react';
import { REMOTE_ANCHOR } from '../domain.js';

export interface SessionSummary { cwd?: string; retainedBy?: Record<string, number> }
/** DSH's client session list: `ids` in list order and `byId` with each conversation's working directory. */
export interface Sessions {
  list: { getSnapshot(): { ids?: string[]; byId?: Record<string, SessionSummary> } | undefined; subscribe(listener: () => void): () => void };
}
let sessions: Sessions | undefined, unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };
/** Set once DSH's session service is available; every subscriber follows it from then on. */
export function setSessions(value: Sessions | undefined): void {
  unsubscribe?.(); sessions = value; unsubscribe = value?.list.subscribe(emit); emit();
}
export const cwdOf = (sessionId: string | undefined) => sessionId ? sessions?.list.getSnapshot()?.byId?.[sessionId]?.cwd : undefined;
/** A conversation working in `root`: the one in view if it does, else the first in the list. */
export function sessionFor(root: string): string | undefined {
  const snapshot = sessions?.list.getSnapshot(), byId = snapshot?.byId ?? {};
  const matching = (snapshot?.ids ?? Object.keys(byId)).filter(id => byId[id]?.cwd === root);
  return matching.find(id => (byId[id]?.retainedBy?.mainView ?? 0) > 0) ?? matching[0];
}
/** Working directories of the conversations on screen. */
export function rootsInView(): string[] {
  const byId = sessions?.list.getSnapshot()?.byId ?? {};
  return [...new Set(Object.values(byId).filter(s => (s.retainedBy?.mainView ?? 0) > 0 && s.cwd).map(s => s.cwd!))];
}
export const isRemote = (cwd: string | undefined) => !!cwd && REMOTE_ANCHOR.test(cwd);
export function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** A conversation's working directory, following session switches and a directory loaded later. */
export function useCwd(sessionId: string | undefined): string | undefined {
  const subscribe = useCallback((listener: () => void) => subscribeSessions(listener), []);
  return useSyncExternalStore(subscribe, () => cwdOf(sessionId));
}
