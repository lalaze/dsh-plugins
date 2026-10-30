import { useCallback, useSyncExternalStore } from 'react';

/** A change running in a workspace folder; `requestId` cancels it. */
export interface Operation { kind: string; requestId: string }
/** The panel's message: a result, an error, or a sign-in problem with HTTPS credentials or SSH keys. */
export interface Notice { text: string; tone: 'ok' | 'error' | 'progress'; auth?: 'https' | 'ssh' }
export interface FolderState { operation?: Operation; notice?: Notice }

/**
 * Per workspace folder, what is running and the last message, kept outside React: closing and reopening the Git tab, or
 * switching conversations and back, shows a running pull and its result again.
 */
const folders = new Map<string, FolderState>(), listeners = new Set<() => void>();
const EMPTY: FolderState = {};
export const folderState = (root: string) => folders.get(root) ?? EMPTY;
export function updateFolder(root: string, patch: Partial<FolderState>): void {
  folders.set(root, { ...folderState(root), ...patch });
  for (const listener of [...listeners]) listener();
}
export function useFolderState(root: string): FolderState {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  return useSyncExternalStore(subscribe, () => folderState(root));
}

/** Announces that a folder's branches or files changed, so the branch button and the Git tab reload. */
const changedListeners = new Set<(root: string) => void>();
export function announceChange(root: string): void { for (const listener of [...changedListeners]) listener(root); }
export function onChange(listener: (root: string) => void): () => void { changedListeners.add(listener); return () => { changedListeners.delete(listener); }; }
