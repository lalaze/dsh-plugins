import { useCallback, useMemo, useSyncExternalStore } from 'react';

export interface Selection { provider: string; model: string; reasoningEffort?: string }
interface ModelStore { getSnapshot(): { current: Selection | null } | undefined; subscribe(listener: () => void): () => void }
/** DSH's `modelDirectories` service, as far as a plugin's page reads it. */
export interface ModelDirectories { directoryFor(sessionId: string): { store: ModelStore; select?(selection: Selection): Promise<unknown> } }

// The picker's directory knows the model a session uses, including a new session's choice before it sends.
let directories: ModelDirectories | undefined;
const listeners = new Set<() => void>();
/** A plugin's page hands over the service once DSH provides it, and takes it back when it goes. */
export const setModelDirectories = (value: ModelDirectories | undefined) => { directories = value; for (const listener of listeners) listener(); };
export const modelDirectories = () => directories;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useCurrentModel(sessionId: string | undefined): Selection | null {
  const resolver = useSyncExternalStore(subscribe, modelDirectories);
  const store = useMemo(() => {
    if (!resolver || !sessionId) return undefined;
    try { return resolver.directoryFor(sessionId).store; } catch { return undefined; }
  }, [resolver, sessionId]);
  const follow = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  return useSyncExternalStore(follow, () => store?.getSnapshot()?.current ?? null);
}
