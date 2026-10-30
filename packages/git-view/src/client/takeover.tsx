import React from 'react';
import { isRemote, useCwd } from './sessions.js';

/** dsh-git-panel's tab beside Chat: its `conversation.view` entry id. */
export const GIT_PANEL_VIEW = 'git-panel';
const VIEW = 'conversation.view';
interface Entry { component: unknown; options: { id?: string; order?: number; label?: unknown; priority?: number } }
/** The part of DSH's slot service this needs; `entries` and `subscribe` read other plugins' registrations. */
export interface ViewSlots {
  register(spec: Record<string, unknown>, component: React.FC<any>): unknown;
  entries?(key: string): readonly Entry[];
  subscribe?(key: string, listener: () => void): () => void;
}

/**
 * dsh-git-panel runs Git on the DSH host only, so in a Remote Agents workspace it reads the local anchor folder rather
 * than the remote repository. While it is installed, its tab shows this plugin's Git view for those conversations and
 * its own view for every other: an entry under its id, one priority lower, shadows its entry and renders it in turn.
 * Call once `conversation.view` is declared; returns the disposer.
 */
export function takeOverGitPanel(slots: ViewSlots, Remote: React.FC<{ sessionId: string }>): () => void {
  const { entries, subscribe } = slots;
  if (typeof entries !== 'function' || typeof subscribe !== 'function') return () => {};
  let theirs: Entry | undefined, dispose: (() => void) | undefined;
  // git-panel's component reads only `sessionId`, and takes the rest of a view's props as they come.
  const View: React.FC<{ sessionId?: string }> = props => {
    const cwd = useCwd(props.sessionId);
    if (props.sessionId && isRemote(cwd)) return <Remote sessionId={props.sessionId} />;
    const Theirs = theirs?.component as React.FC<any> | undefined;
    return Theirs ? <Theirs {...props} /> : null;
  };
  const sync = () => {
    const found = entries.call(slots, VIEW).find(entry => entry.options.id === GIT_PANEL_VIEW && entry.component !== View);
    if (found === theirs) return;
    dispose?.(); dispose = undefined; theirs = found;
    // Its label and place in the tab row, so the tab looks the same.
    if (found) dispose = slots.register({ name: VIEW, id: GIT_PANEL_VIEW, priority: (found.options.priority ?? 0) - 1,
      order: found.options.order, label: found.options.label }, View) as () => void;
  };
  sync();
  const off = subscribe.call(slots, VIEW, sync);
  return () => { off(); dispose?.(); dispose = undefined; theirs = undefined; };
}
