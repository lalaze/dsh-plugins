import React from 'react';
import { isRemote, useCwd } from './sessions.js';

/** dsh-git-panel's tab beside Chat (its `conversation.view` id) and its right sidebar tab (its `sidebar.right.pane.tab` key). */
export const GIT_PANEL_VIEW = 'git-panel', GIT_PANEL_TAB = '@xbzbing/dsh-git-panel';
interface Entry { component: unknown; options: { id?: string; key?: string } }
/** The part of DSH's slot service this needs; `entries` and `subscribe` read other plugins' registrations. */
export interface ViewSlots {
  register(spec: Record<string, unknown>, component: React.FC<any>): unknown;
  entries?(key: string): readonly Entry[];
  subscribe?(key: string, listener: () => void): () => void;
}
type Props = { sessionId?: string };

function Choose({ props, Own, Remote }: { props: Props; Own: React.FC<any>; Remote: React.FC<{ sessionId: string }> }) {
  const cwd = useCwd(props.sessionId);
  return props.sessionId && isRemote(cwd) ? <Remote sessionId={props.sessionId} /> : <Own {...props} />;
}

/**
 * dsh-git-panel runs Git on the DSH host only, so in a Remote Agents workspace it reads the local anchor folder rather
 * than the remote repository. Its entries in `slot` that `theirs` picks show `Remote` for those conversations and their
 * own view for every other. The entry's component is swapped in place, not shadowed by a second registration: DSH
 * builds the conversation's tab row from every entry, so a shadowing entry would show as a second Git tab. Its
 * components read only `sessionId` and take the rest of their props as they come. `onPresent` follows whether such an
 * entry exists. Call once `slot` is declared; returns the disposer, which gives the entries back their components.
 */
export function takeOverGitPanel(slots: ViewSlots, slot: string, theirs: (entry: Entry) => boolean, Remote: React.FC<{ sessionId: string }>,
  onPresent?: (present: boolean) => void): () => void {
  const { entries, subscribe } = slots;
  if (typeof entries !== 'function' || typeof subscribe !== 'function') return () => {};
  const taken = new Map<Entry, { own: unknown; wrapper: React.FC<Props> }>();
  let present = false;
  const sync = () => {
    const live = entries.call(slots, slot).filter(theirs);
    for (const entry of live) {
      if (taken.has(entry)) continue;
      const Own = entry.component as React.FC<any>, wrapper: React.FC<Props> = props => <Choose props={props} Own={Own} Remote={Remote} />;
      taken.set(entry, { own: Own, wrapper });
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
