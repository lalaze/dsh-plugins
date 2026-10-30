import React from 'react';

/** dsh-git-panel's tab beside Chat, its right sidebar page and its input-bar marker, by their slot ids and key. */
export const GIT_PANEL_VIEW = 'git-panel', GIT_PANEL_TAB = '@xbzbing/dsh-git-panel', GIT_PANEL_PILL = 'git-panel-pill';
interface Entry { component: unknown; options: { id?: string; key?: string } }
/** The part of DSH's slot service this needs; `entries` and `subscribe` read other plugins' registrations. */
export interface ViewSlots {
  register(spec: Record<string, unknown>, component: React.FC<any>): unknown;
  entries?(key: string): readonly Entry[];
  subscribe?(key: string, listener: () => void): () => void;
}
/** The slot props dsh-git-panel's entries receive; its components read only `sessionId` (and the sidebar's `useTabInfo`). */
type Props = { sessionId?: string; [key: string]: unknown };

/**
 * dsh-git-panel and this plugin offer the same panel, ported from it, but dsh-git-panel runs Git on the DSH host only, so
 * in a Remote Agents workspace it reads the local anchor folder rather than the remote repository. While it is installed,
 * its entries in `slot` that `theirs` picks render `Ours` instead, for every conversation, and this plugin's own entries
 * step aside (see `onPresent`). The entry's component is swapped in place, not shadowed by a second registration: DSH
 * builds the conversation's tab row from every entry, so a shadowing entry would show as a second Git tab. Call once
 * `slot` is declared; returns the disposer, which gives the entries back their components.
 */
export function takeOverGitPanel(slots: ViewSlots, slot: string, theirs: (entry: Entry) => boolean, Ours: React.FC<Props>,
  onPresent?: (present: boolean) => void): () => void {
  const { entries, subscribe } = slots;
  if (typeof entries !== 'function' || typeof subscribe !== 'function') return () => {};
  const taken = new Map<Entry, { own: unknown; wrapper: React.FC<Props> }>();
  let present = false;
  const sync = () => {
    const live = entries.call(slots, slot).filter(theirs);
    for (const entry of live) {
      if (taken.has(entry)) continue;
      const wrapper: React.FC<Props> = props => <Ours {...props} />;
      taken.set(entry, { own: entry.component, wrapper });
      entry.component = wrapper;
    }
    for (const entry of [...taken.keys()]) if (!live.includes(entry)) taken.delete(entry);
    if (present !== live.length > 0) { present = live.length > 0; onPresent?.(present); }
  };
  sync();
  const off = subscribe.call(slots, slot, sync);
  return () => {
    off();
    for (const [entry, { own, wrapper }] of taken) if (entry.component === wrapper) entry.component = own;
    taken.clear();
  };
}
