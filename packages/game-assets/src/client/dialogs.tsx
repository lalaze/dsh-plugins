import React, { useState } from 'react';
import type { Asset } from '../domain.js';
import { ui } from './i18n.js';
import { agentMessage, formatBytes } from './model.js';

const Dialog = ({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) =>
  <div className="ga-overlay" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="ga-dialog"><h3>{title}</h3>{children}</div>
  </div>;

/** Says what retiring will move, and how much of it the code still refers to, before anything moves. */
export function RetireDialog({ assets, retireDir, busy, onConfirm, onClose }: { assets: Asset[]; retireDir: string; busy: boolean; onConfirm(): void; onClose(): void }) {
  const used = assets.filter(asset => asset.usage === 'used').length, maybe = assets.filter(asset => asset.usage === 'maybe').length;
  const bytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  return <Dialog title={ui('Retire {count} images?', { count: assets.length })} onClose={onClose}>
    <p>{ui('They move to “{folder}”, each under its present path ({size} in all). Nothing is deleted, and Retired → Restore puts them back.', { folder: `${retireDir}/`, size: formatBytes(bytes) })}</p>
    {used + maybe > 0
      ? <div className="ga-banner" data-tone="warn" role="alert">{ui('The code still refers to some of these: {used} in use, {maybe} maybe in use. The game may fail to load them once they move.', { used, maybe })}</div>
      : <p className="ga-dim">{ui('No code in the folders being read refers to any of them.')}</p>}
    <p className="ga-actions ga-end">
      <button type="button" className="ga-button" onClick={onClose}>{ui('Cancel')}</button>
      <button type="button" className="ga-button" data-primary disabled={busy} onClick={onConfirm}>{ui('Retire {count} images', { count: assets.length })}</button>
    </p>
  </Dialog>;
}

/** Adds a tag to every selected image, or removes one that some of them have. Each change is saved as it is made. */
export function TagDialog({ assets, known, busy, onChange, onClose }: { assets: Asset[]; known: string[]; busy: boolean; onChange(add: string[], remove: string[]): void; onClose(): void }) {
  const [draft, setDraft] = useState('');
  const counts = new Map<string, number>();
  for (const asset of assets) for (const tag of asset.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const add = (tag: string) => { const clean = tag.trim(); if (clean) { onChange([clean], []); setDraft(''); } };
  const offered = known.filter(tag => counts.get(tag) !== assets.length).slice(0, 12);
  return <Dialog title={ui('Tags of {count} images', { count: assets.length })} onClose={onClose}>
    <form className="ga-tag-form" onSubmit={event => { event.preventDefault(); add(draft); }}>
      <input className="ga-search" autoFocus maxLength={40} placeholder={ui('New tag')} aria-label={ui('New tag')} value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="ga-button" data-primary disabled={busy || !draft.trim()}>{ui('Add')}</button>
    </form>
    {counts.size > 0 && <div className="ga-taglist" aria-label={ui('Tags on these images')}>
      {[...counts].map(([tag, count]) => <span key={tag} className="ga-tag" data-tone="tag">{tag}{count < assets.length && <i className="ga-dim"> {count}/{assets.length}</i>}
        <button type="button" aria-label={ui('Remove tag {tag}', { tag })} disabled={busy} onClick={() => onChange([], [tag])}>×</button></span>)}
    </div>}
    {offered.length > 0 && <><p className="ga-dim">{ui('Tags used elsewhere')}</p>
      <div className="ga-taglist">{offered.map(tag => <button key={tag} type="button" className="ga-tag ga-tag-add" disabled={busy} onClick={() => add(tag)}>+ {tag}</button>)}</div></>}
    <p className="ga-actions ga-end"><button type="button" className="ga-button" onClick={onClose}>{ui('Done')}</button></p>
  </Dialog>;
}

const PRESETS = [
  ['Check and remove', 'Check that the game no longer loads any of these images, including through paths built at run time. Remove the ones that are safe to remove, and tell me which you kept and why.'],
  ['Where are they used', 'For each of these images, find where the game loads it and say whether it is still needed.'],
  ['Redraw', 'Redraw these images in the project’s current art style. Keep each file’s name, pixel size and transparency.'],
] as const;

/** Writes the request for the agent: an instruction the user can edit, followed by the selected paths. */
export function SendDialog({ assets, onSend, onClose }: { assets: Asset[]; onSend(text: string): void; onClose(): void }) {
  const start = assets.every(asset => asset.usage === 'unused' && !asset.retired) ? 0 : 1;
  const [instruction, setInstruction] = useState(() => ui(PRESETS[start][1]));
  return <Dialog title={ui('Ask the agent about {count} images', { count: assets.length })} onClose={onClose}>
    <div className="ga-taglist">{PRESETS.map(([label, text]) => <button key={label} type="button" className="ga-tag ga-tag-add" onClick={() => setInstruction(ui(text))}>{ui(label)}</button>)}</div>
    <textarea className="ga-textarea" rows={5} aria-label={ui('Instruction')} value={instruction} onChange={event => setInstruction(event.target.value)} />
    <p className="ga-dim">{ui('The paths of the {count} images are added below the instruction. It goes into the chat input; nothing is sent until you send it.', { count: assets.length })}</p>
    <p className="ga-actions ga-end">
      <button type="button" className="ga-button" onClick={onClose}>{ui('Cancel')}</button>
      <button type="button" className="ga-button" data-primary disabled={!instruction.trim()}
        onClick={() => onSend(agentMessage(instruction, assets.map(asset => asset.path), count => ui('…and {count} more images of the same selection', { count })))}>{ui('Put in chat input')}</button>
    </p>
  </Dialog>;
}
