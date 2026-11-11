import React, { useState } from 'react';
import type { Route } from '../domain.js';
import { ui } from './i18n.js';
import { Pick } from './pick.js';
import { usePictures } from './pictures.js';

export interface NewBug { title: string; body: string; images: { name: string; mediaType: string; data: string }[]; assignment: { routeId: string; branch: string } | null }

/**
 * A bug typed in by hand: a title, what is wrong, and pictures. Pictures come from the file chooser, from the
 * clipboard (a screenshot pasted anywhere in the form) or dropped onto it.
 */
export function NewBugForm({ routes, branches, busy, onSubmit, onCancel }: { routes: readonly Route[]; branches(route: Route): string[]; busy: boolean; onSubmit(bug: NewBug, start: boolean): Promise<boolean>; onCancel(): void }) {
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), added = usePictures();
  const [routeId, setRouteId] = useState(routes.length === 1 ? routes[0].id : ''), [branch, setBranch] = useState(routes.length === 1 ? routes[0].defaultBranch : '');
  const route = routes.find(entry => entry.id === routeId);
  const submit = async (start: boolean) => {
    const done = await onSubmit({ title, body, images: added.payload(), assignment: route ? { routeId: route.id, branch: branch || route.defaultBranch } : null }, start);
    if (done) onCancel();
  };
  return <form className="tp-card tp-new" {...added.zone} onSubmit={event => { event.preventDefault(); void submit(false); }}>
    <input autoFocus className="tp-new-title" value={title} maxLength={300} placeholder={ui("What is wrong, in one line")} aria-label={ui("Title")} onChange={event => setTitle(event.target.value)} />
    <textarea rows={5} value={body} placeholder={ui("How to see it, what should happen instead. Paste or drop screenshots here.")} aria-label={ui("Description")} onChange={event => setBody(event.target.value)} />
    {added.view(index => `[image ${index + 1}]`)}
    <div className="tp-assign">
      <button type="button" className="tp-button" disabled={added.full} onClick={added.choose}>{ui("Add pictures")}</button>
      <Pick label={ui("Repository")} value={routeId} placeholder={ui("Choose a repository…")} options={[{ value: '', label: ui("Decide later") }, ...routes.map(entry => ({ value: entry.id, label: entry.name }))]}
        onChange={value => { setRouteId(value); setBranch(routes.find(entry => entry.id === value)?.defaultBranch ?? ''); }} />
      {route && <Pick label={ui("Branch")} value={branch} options={[...new Set([branch, ...branches(route)].filter(Boolean))].map(name => ({ value: name, label: name }))} onChange={setBranch} />}
      <span className="tp-spacer" />
      <button type="button" className="tp-button" data-quiet onClick={onCancel}>{ui("Cancel")}</button>
      <button type="submit" className="tp-button" disabled={busy || !title.trim()}>{ui("Add")}</button>
      <button type="button" className="tp-button" data-primary disabled={busy || !title.trim() || !route} onClick={() => void submit(true)}>{ui("Add and start")}</button>
    </div>
  </form>;
}
