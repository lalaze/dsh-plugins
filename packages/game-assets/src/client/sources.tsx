/** The image APIs pictures are generated with: one list, shared by the settings page and the generate dialog. */
import React, { useEffect, useState } from 'react';
import { SOURCE_DEFAULTS, SOURCE_KINDS, type SourceKind, type SourcesAnswer, type SourceView } from '../domain.js';
import { deleteSource, listSources, saveSource, setDefaultSource } from './api.js';
import { localizePictureError, ui } from './i18n.js';

export const KIND_LABEL: Record<SourceKind, string> = { openai: 'OpenAI compatible', gemini: 'Gemini' };

let current: SourcesAnswer | undefined, loading: Promise<void> | undefined, failure = '';
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
export function adoptSources(next: SourcesAnswer): void { current = next; failure = ''; emit(); }
/** Asks the host for the list once; `again` asks anew. */
export function loadSources(again = false): Promise<void> {
  if (loading && !again) return loading;
  return loading = listSources().then(adoptSources, error => { failure = localizePictureError(error); loading = undefined; emit(); });
}
export function resetSources(): void { current = undefined; loading = undefined; failure = ''; }
/** The sources as the host last said, and why they could not be read. */
export function useSources(): { answer?: SourcesAnswer; error: string } {
  const [, render] = useState(0);
  useEffect(() => {
    const listener = () => render(n => n + 1);
    listeners.add(listener);
    void loadSources();
    return () => { listeners.delete(listener); };
  }, []);
  return { answer: current, error: failure };
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Adds a source, or edits one; a saved key is kept unless a new one is typed. */
function SourceForm({ source, onDone }: { source?: SourceView; onDone(id?: string): void }) {
  const [kind, setKind] = useState<SourceKind>(source?.kind ?? 'openai');
  const [name, setName] = useState(source?.name ?? ui(KIND_LABEL.openai));
  const [baseUrl, setBaseUrl] = useState(source?.baseUrl ?? SOURCE_DEFAULTS.openai.baseUrl), [model, setModel] = useState(source?.model ?? SOURCE_DEFAULTS.openai.model);
  const [apiKey, setApiKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  /** A new source follows the kind it is switched to until the user has changed what the old kind filled in. */
  const switchKind = (next: SourceKind) => {
    if (!source) {
      if (name === ui(KIND_LABEL[kind])) setName(ui(KIND_LABEL[next]));
      if (baseUrl === SOURCE_DEFAULTS[kind].baseUrl) setBaseUrl(SOURCE_DEFAULTS[next].baseUrl);
      if (model === SOURCE_DEFAULTS[kind].model) setModel(SOURCE_DEFAULTS[next].model);
    }
    setKind(next);
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    saveSource({ ...(source ? { id: source.id } : {}), name, kind, baseUrl, model, ...(apiKey.trim() || !source ? { apiKey } : {}) })
      .then(answer => { adoptSources(answer); onDone(answer.id); }, e => { setError(localizePictureError(e)); setBusy(false); });
  };
  const list = `ga-models-${kind}`;
  return <form className="ga-sform" onSubmit={submit} aria-label={ui(source ? 'Edit image source' : 'Add image source')}>
    <div className="ga-modes" role="radiogroup" aria-label={ui('Kind of API')}>
      {SOURCE_KINDS.map(value => <label key={value}><input type="radio" name="ga-kind" checked={kind === value} onChange={() => switchKind(value)} />{ui(KIND_LABEL[value])}</label>)}
    </div>
    <label className="ga-sfield"><span>{ui('Name')}</span><input className="ga-search" maxLength={60} required value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="ga-sfield"><span>{ui('Address')}</span><input className="ga-search" type="url" required spellCheck={false} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
    <label className="ga-sfield"><span>{ui('Model')}</span><input className="ga-search" list={list} required spellCheck={false} value={model} onChange={event => setModel(event.target.value)} />
      <datalist id={list}>{SOURCE_DEFAULTS[kind].models.map(entry => <option key={entry} value={entry} />)}</datalist></label>
    <label className="ga-sfield"><span>{ui('API key')}</span><input className="ga-search" type="password" autoComplete="off" spellCheck={false} value={apiKey}
      placeholder={source?.keyHint ? ui('Saved ({hint}); leave empty to keep it', { hint: source.keyHint }) : kind === 'openai' ? 'sk-…' : 'AIza…'} onChange={event => setApiKey(event.target.value)} /></label>
    <p className="ga-dim">{ui(kind === 'openai'
      ? 'Any service that answers OpenAI’s /images/generations and /images/edits: OpenAI itself, or a relay. Use the address up to /v1.'
      : 'Google’s Gemini API or a relay that answers its generateContent. Gemini pictures have no transparent background.')}</p>
    {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
    <p className="ga-actions ga-end">
      <button type="button" className="ga-button" onClick={() => onDone()}>{ui('Cancel')}</button>
      <button type="submit" className="ga-button" data-primary disabled={busy}>{ui('Save')}</button>
    </p>
  </form>;
}

/**
 * The saved sources, to pick the default from, edit or remove, and a form to add one. Keys stay on the computer DSH
 * runs on; this page only ever sees their last characters.
 */
export function SourceSettings({ adding = false, onAdded }: { adding?: boolean; onAdded?(id: string): void }) {
  const { answer, error: loadError } = useSources();
  const [editing, setEditing] = useState<string | 'new' | undefined>(adding ? 'new' : undefined), [removing, setRemoving] = useState<string>(), [error, setError] = useState('');
  const act = (task: Promise<SourcesAnswer>) => { setError(''); task.then(adoptSources, e => setError(localizePictureError(e))); };
  const sources = answer?.sources ?? [];
  return <div className="ga-sources">
    {loadError && <div className="ga-banner" data-tone="error" role="alert">{loadError}</div>}
    {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
    {!answer && !loadError && <p className="ga-dim">{ui('Loading…')}</p>}
    {sources.length > 0 && <div className="ga-folders" role="table" aria-label={ui('Image sources')}>{sources.map(source => editing === source.id
      ? <SourceForm key={source.id} source={source} onDone={() => setEditing(undefined)} />
      : <div key={source.id} className="ga-frow ga-srow" role="row">
        <span role="cell" className="ga-wname"><b>{source.name}{answer?.defaultId === source.id && <span className="ga-tag ga-default">{ui('default')}</span>}</b>
          <span className="ga-dim" title={source.baseUrl}>{ui(KIND_LABEL[source.kind])} · {source.model} · {hostOf(source.baseUrl)} · {source.keyHint ? ui('key {hint}', { hint: source.keyHint }) : ui('no key')}</span></span>
        <span role="cell" className="ga-actions">
          {answer?.defaultId !== source.id && <button type="button" className="ga-button" onClick={() => act(setDefaultSource(source.id))}>{ui('Make default')}</button>}
          <button type="button" className="ga-button" onClick={() => { setEditing(source.id); setRemoving(undefined); }}>{ui('Edit')}</button>
          {removing === source.id
            ? <button type="button" className="ga-button" data-danger onClick={() => { setRemoving(undefined); act(deleteSource(source.id)); }}>{ui('Remove for good')}</button>
            : <button type="button" className="ga-button" onClick={() => setRemoving(source.id)}>{ui('Remove')}</button>}
        </span>
      </div>)}</div>}
    {editing === 'new'
      ? <SourceForm onDone={id => { setEditing(undefined); if (id) onAdded?.(id); }} />
      : answer && <p className="ga-actions"><button type="button" className="ga-button" onClick={() => { setEditing('new'); setRemoving(undefined); }}>{ui('Add image source')}</button></p>}
    <p className="ga-dim">{ui('Keys are kept only on the computer DSH runs on, in its home folder, and are never sent to this page. Pictures are generated from there, for remote workspaces too.')}</p>
  </div>;
}
