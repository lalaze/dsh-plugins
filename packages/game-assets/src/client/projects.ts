/**
 * Which conversations get the Assets tab. DSH registers a conversation view for every conversation at once, so the tab
 * is registered only while a conversation on screen belongs to a game project, and released otherwise.
 */
import { useSyncExternalStore } from 'react';
import { REMOTE_ANCHOR, type ProjectStatus, type TabMode } from '../domain.js';
import { projectStatus, setProject, setTabMode, tabMode } from './api.js';

export interface SessionSummary { cwd?: string; retainedBy?: Record<string, number> }
/** DSH's client session list: `ids` in list order and `byId` with each conversation's working directory. */
export interface Sessions {
  list: { getSnapshot(): { ids?: string[]; byId?: Record<string, SessionSummary> } | undefined; subscribe(listener: () => void): () => void };
}

let sessions: Sessions | undefined, mode: TabMode | undefined, revision = 0;
const known = new Map<string, ProjectStatus>(), loading = new Map<string, Promise<void>>(), listeners = new Set<() => void>();
/** Conversations whose answer could not be had; they are not asked again until something changes. */
const failed = new Set<string>();
const emit = () => { revision++; for (const listener of [...listeners]) listener(); };
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const setSessions = (value: Sessions | undefined) => { sessions = value; emit(); };
export const hasSessions = () => sessions !== undefined;
/** Conversations on screen. */
export function sessionsInView(): string[] {
  const snapshot = sessions?.list.getSnapshot(), byId = snapshot?.byId ?? {};
  return (snapshot?.ids ?? Object.keys(byId)).filter(id => (byId[id]?.retainedBy?.mainView ?? 0) > 0);
}
/** One conversation per local workspace folder, most recent first, for the settings page. */
export function workspaces(limit = 20): { sessionId: string; cwd: string }[] {
  const snapshot = sessions?.list.getSnapshot(), byId = snapshot?.byId ?? {}, seen = new Set<string>(), result: { sessionId: string; cwd: string }[] = [];
  for (const sessionId of snapshot?.ids ?? Object.keys(byId)) {
    const cwd = byId[sessionId]?.cwd;
    if (!cwd || REMOTE_ANCHOR.test(cwd) || seen.has(cwd)) continue;
    seen.add(cwd); result.push({ sessionId, cwd });
    if (result.length >= limit) break;
  }
  return result;
}

export const statusOf = (sessionId: string | undefined) => sessionId ? known.get(sessionId) : undefined;
export const currentMode = () => mode;
/** Asks once whether the conversation's workspace is a game project; listeners hear when the answer arrives. */
export function ensure(sessionId: string): Promise<void> {
  if (known.has(sessionId) || failed.has(sessionId)) return Promise.resolve();
  let pending = loading.get(sessionId);
  if (!pending) {
    pending = projectStatus(sessionId).then(status => { known.set(sessionId, status); mode = status.mode; }, () => { failed.add(sessionId); })
      .finally(() => { loading.delete(sessionId); emit(); });
    loading.set(sessionId, pending);
  }
  return pending;
}
/** True once the question was asked and went unanswered: the caller shows what it can without the answer. */
export const hasFailed = (sessionId: string | undefined) => !!sessionId && failed.has(sessionId);
export async function loadMode(): Promise<void> {
  if (mode !== undefined) return;
  // A host that cannot answer keeps the default, so the tab is not held back forever.
  try { mode = (await tabMode()).mode; } catch { mode ??= 'games'; }
  emit();
}
/** Saves the user's choice for the conversation's workspace. Other conversations of that workspace are asked again. */
export async function chooseProject(sessionId: string, game: boolean | null): Promise<void> {
  const status = await setProject(sessionId, game);
  known.clear(); failed.clear(); known.set(sessionId, status); mode = status.mode;
  emit();
}
export async function chooseMode(next: TabMode): Promise<void> {
  mode = (await setTabMode(next)).mode;
  for (const [id, status] of known) known.set(id, { ...status, mode });
  emit();
}

/**
 * Whether the tab should be registered now: everywhere, or while a conversation on screen is a game project. Undefined
 * while an answer is on its way, so the tab neither flashes nor vanishes during a switch of conversations.
 */
export function tabWanted(): boolean | undefined {
  if (mode === 'all') return true;
  const inView = sessionsInView();
  for (const id of inView) void ensure(id);
  if (inView.some(id => known.get(id)?.game)) return true;
  return inView.some(id => !known.has(id) && !failed.has(id)) || mode === undefined ? undefined : false;
}

/** The project status of a conversation, asked for when first used. */
export function useProject(sessionId: string | undefined): { status: ProjectStatus | undefined; mode: TabMode | undefined; failed: boolean } {
  useSyncExternalStore(subscribe, () => revision, () => revision);
  if (sessionId) void ensure(sessionId);
  return { status: statusOf(sessionId), mode, failed: hasFailed(sessionId) };
}
/** For tests: forget everything learned. */
export function resetProjects(): void { sessions = undefined; mode = undefined; known.clear(); failed.clear(); loading.clear(); listeners.clear(); revision = 0; }
