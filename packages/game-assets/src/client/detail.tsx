import React, { useEffect, useRef, useState } from 'react';
import { RAW_LIMIT, extensionOf, type Asset, type AssetDetail, type ScanResult, type Usage } from '../domain.js';
import { assetDetail } from './api.js';
import { Picture } from './grid.js';
import { localizeError, ui } from './i18n.js';
import { dirOf, formatBytes, nameOf } from './model.js';

export const USAGE_LABEL: Record<Usage, string> = { used: 'In use', maybe: 'Maybe in use', unused: 'Unreferenced' };
const USAGE_NOTE: Record<Usage, string> = {
  used: 'Code names this file by its path.',
  maybe: 'Only an indirect reference was found: a path built at run time, a folder, or a bare name. Check before deleting.',
  unused: 'No code in the folders being read mentions this file.',
};
const KIND_LABEL = { path: 'path', pattern: 'built path', folder: 'folder', name: 'name only' } as const;

export interface DetailProps {
  sessionId: string;
  asset: Asset;
  result: ScanResult;
  /** Other images with the same file name. */
  twins: Asset[];
  onSelect(path: string): void;
  onClose(): void;
  onCopy(text: string): void;
  /** Opens a workspace file beside the conversation; absent when the host has no right sidebar. */
  openFile?(path: string, line?: number): void;
  /** Tags in use in the workspace, offered while typing. */
  knownTags: string[];
  onTag(add: string[], remove: string[]): void;
  onNote(note: string): void;
  /** Asks to retire this image, or restores it when it is retired. */
  onMove(): void;
}

/** An image's tags as removable chips with a field to add one, and its note, saved when the field is left. */
function Labels({ asset, knownTags, onTag, onNote }: Pick<DetailProps, 'asset' | 'knownTags' | 'onTag' | 'onNote'>) {
  const [draft, setDraft] = useState(''), [note, setNote] = useState(asset.note ?? '');
  const saved = useRef(asset.note ?? '');
  useEffect(() => { setDraft(''); setNote(asset.note ?? ''); saved.current = asset.note ?? ''; }, [asset.path, asset.note]);
  const list = `ga-tags-${asset.path.length}`;
  return <section>
    <h4>{ui('Tags')}</h4>
    <form className="ga-taglist" onSubmit={event => { event.preventDefault(); if (draft.trim()) { onTag([draft.trim()], []); setDraft(''); } }}>
      {(asset.tags ?? []).map(tag => <span key={tag} className="ga-tag" data-tone="tag">{tag}<button type="button" aria-label={ui('Remove tag {tag}', { tag })} onClick={() => onTag([], [tag])}>×</button></span>)}
      <input className="ga-tag-input" list={list} maxLength={40} placeholder={ui('Add tag')} aria-label={ui('Add tag')} value={draft} onChange={event => setDraft(event.target.value)} />
      <datalist id={list}>{knownTags.filter(tag => !asset.tags?.includes(tag)).map(tag => <option key={tag} value={tag} />)}</datalist>
    </form>
    <textarea className="ga-textarea" rows={2} maxLength={2000} placeholder={ui('Note')} aria-label={ui('Note')} value={note} onChange={event => setNote(event.target.value)}
      onBlur={() => { if (note.trim() !== saved.current.trim()) { saved.current = note; onNote(note); } }} />
  </section>;
}

/** One image: a large preview, what it is, every reference to it, and the other files of the same name. */
export function Detail({ sessionId, asset, result, twins, onSelect, onClose, onCopy, openFile, knownTags, onTag, onNote, onMove }: DetailProps) {
  const [detail, setDetail] = useState<AssetDetail>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setDetail(undefined); setError('');
    if (asset.refCount) assetDetail(sessionId, asset.path, controller.signal).then(setDetail, e => { if (!controller.signal.aborted) setError(localizeError(e)); });
    return () => controller.abort();
  }, [sessionId, asset.path, asset.refCount, result.scannedAt]);
  const family = asset.family ? result.families.find(entry => entry.id === asset.family) : undefined;
  const latest = family?.versions[family.versions.length - 1].label;
  const others = asset.dup === undefined ? 0 : result.assets.filter(other => other.dup === asset.dup).length - 1;

  return <aside className="ga-detail" aria-label={nameOf(asset.path)}>
    <header className="ga-detail-head">
      <strong title={asset.path}>{nameOf(asset.path)}</strong>
      <button type="button" className="ga-tool" title={ui('Close')} aria-label={ui('Close')} onClick={onClose}>×</button>
    </header>
    <div className="ga-detail-body">
      <div className="ga-preview"><Picture sessionId={sessionId} asset={asset} box={256} limit={RAW_LIMIT} /></div>
      <p className="ga-facts">
        {asset.width ? `${asset.width} × ${asset.height} · ` : ''}{formatBytes(asset.size)} · {extensionOf(asset.path).toUpperCase()}
        {family && <> · {family.name || family.dir} {asset.version}{asset.version === latest ? ` (${ui('latest')})` : ''}</>}
      </p>
      <p className="ga-path"><code>{dirOf(asset.path) ? `${dirOf(asset.path)}/` : ''}<b>{nameOf(asset.path)}</b></code></p>
      <p className="ga-actions">
        <button type="button" className="ga-button" onClick={() => onCopy(asset.path)}>{ui('Copy path')}</button>
        {openFile && <button type="button" className="ga-button" onClick={() => openFile(asset.path)}>{ui('Open beside chat')}</button>}
        {(!asset.retired || asset.origin) && <button type="button" className="ga-button" onClick={onMove}>{ui(asset.retired ? 'Restore' : 'Retire…')}</button>}
      </p>
      {asset.retired
        ? <p className="ga-verdict" data-usage="retired"><i className="ga-dot" /><b>{ui('Retired')}</b> {asset.origin ? ui('From {path}.', { path: asset.origin }) : ui('Where it came from was not recorded, so it cannot be restored from here.')}</p>
        : <p className="ga-verdict" data-usage={asset.usage}><i className="ga-dot" /><b>{ui(USAGE_LABEL[asset.usage])}</b> {ui(USAGE_NOTE[asset.usage])}</p>}
      {others > 0 && <p className="ga-verdict"><b className="ga-tag">{ui('copy')}</b> {ui('{count} other files have exactly the same bytes.', { count: others })}</p>}

      <Labels asset={asset} knownTags={knownTags} onTag={onTag} onNote={onNote} />

      {asset.refCount > 0 && <section>
        <h4>{ui('References')} <span className="ga-dim">{asset.refCount}</span></h4>
        {error ? <p className="ga-dim" role="alert">{error}</p> : !detail ? <p className="ga-dim">{ui('Loading…')}</p> : <ul className="ga-refs">
          {detail.refs.map(ref => <li key={`${ref.file}:${ref.line}`}>
            <button type="button" className="ga-link" disabled={!openFile} onClick={() => openFile?.(ref.file, ref.line)} title={ref.file}>{ref.file}:{ref.line}</button>
            <span className="ga-kind" data-kind={ref.kind}>{ui(KIND_LABEL[ref.kind])}</span>
            <code>{ref.text}</code>
          </li>)}
          {detail.refCount > detail.refs.length && <li className="ga-dim">{ui('and {count} more', { count: detail.refCount - detail.refs.length })}</li>}
        </ul>}
      </section>}

      {twins.length > 0 && <section>
        <h4>{ui('Same name elsewhere')} <span className="ga-dim">{twins.length}</span></h4>
        <ul className="ga-twins">
          {twins.slice(0, 40).map(twin => <li key={twin.path}>
            <button type="button" className="ga-twin" data-usage={twin.retired ? 'retired' : twin.usage} onClick={() => onSelect(twin.path)} title={twin.path}>
              <span className="ga-twin-thumb"><Picture sessionId={sessionId} asset={twin} box={36} /></span>
              <span className="ga-twin-path">{twin.path}</span>
              <span className="ga-meta"><i className="ga-dot" />{ui(twin.retired ? 'Retired' : USAGE_LABEL[twin.usage])}{twin.dup !== undefined && twin.dup === asset.dup && <b className="ga-tag">{ui('identical')}</b>}{twin.version && <span>{twin.version}</span>}</span>
            </button>
          </li>)}
          {twins.length > 40 && <li className="ga-dim">{ui('and {count} more', { count: twins.length - 40 })}</li>}
        </ul>
      </section>}
    </div>
  </aside>;
}
