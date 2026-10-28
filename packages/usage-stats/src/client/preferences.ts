import { useSyncExternalStore } from 'react';

/** Settings for this device only, kept in the browser's storage. */
export interface Preferences { headerBadge: boolean }
export const DEFAULTS: Preferences = { headerBadge: true };
const KEY = 'dsh-usage-stats.preferences';
const listeners = new Set<() => void>();
let cached: { raw: string | null; value: Preferences } | undefined;
/** Set when storage refused a write: the change lasts until reload. */
let memory: Preferences | undefined;

const storage = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
/** Saved preferences over the defaults; unreadable or malformed storage reads as the defaults. */
export function readPreferences(): Preferences {
  if (memory) return memory;
  let raw: string | null = null;
  try { raw = storage()?.getItem(KEY) ?? null; } catch { /* Storage blocked: use the defaults. */ }
  if (cached?.raw === raw) return cached.value;
  let value = DEFAULTS;
  try {
    const saved: unknown = raw ? JSON.parse(raw) : undefined;
    if (saved && typeof saved === 'object' && typeof (saved as Preferences).headerBadge === 'boolean') value = { ...DEFAULTS, headerBadge: (saved as Preferences).headerBadge };
  } catch { /* Malformed: use the defaults. */ }
  cached = { raw, value };
  return value;
}
export function savePreferences(change: Partial<Preferences>): void {
  const next = { ...readPreferences(), ...change };
  try { const target = storage(); if (!target) throw new Error('No storage'); target.setItem(KEY, JSON.stringify(next)); memory = undefined; }
  catch { memory = next; }
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window of the same app changed the setting.
  const changed = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  globalThis.addEventListener?.('storage', changed);
  return () => { listeners.delete(listener); globalThis.removeEventListener?.('storage', changed); };
}
export const usePreferences = () => useSyncExternalStore(subscribe, readPreferences, () => DEFAULTS);
