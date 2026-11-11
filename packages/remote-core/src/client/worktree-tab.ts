/**
 * Add workspace is Remote Agents' dialog, and its "From a project" tab is dsh-remote-terminals'. Their pages are two
 * bundles on one page, sharing React but no module, so the tab is handed over through the page itself.
 */
export interface WorktreeTab<Component = unknown> {
  /** The projects a workspace can be made from; empty when there is none. */
  projects(signal?: AbortSignal): Promise<readonly unknown[]>;
  /** Draws the tab from `{ projects, busy, onPicked(path) }`, inside the dialog and its styles. */
  Flow: Component;
}
const KEY = '__dshRemoteWorktreeTab', EVENT = 'dsh-remote-worktree-tab';
type Page = { [KEY]?: WorktreeTab };
/** @returns takes the tab back, as when the plugin offering it is switched off. */
export function offerWorktreeTab(tab: WorktreeTab): () => void {
  const page = window as unknown as Page;
  page[KEY] = tab; window.dispatchEvent(new Event(EVENT));
  return () => { if (page[KEY] === tab) { delete page[KEY]; window.dispatchEvent(new Event(EVENT)); } };
}
export const worktreeTab = <Component>() => (typeof window === 'undefined' ? undefined : (window as unknown as Page)[KEY]) as WorktreeTab<Component> | undefined;
export function onWorktreeTab(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
