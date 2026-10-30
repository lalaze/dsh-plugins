import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import { CodeEditor, ImagePreview, MarkdownPreview, imageType, isMarkdown } from '@dsh-plugins/file-view';
import { EDITOR_SRC, fileRequest, type FileRead, type FileState, type Saved } from './api.js';
import { i18n, localizeError, ui } from './i18n.js';
import { styles } from './styles.js';

/** How often an open file is checked for changes made elsewhere, such as by an agent. */
const POLL_MS = 2000;

/** One local file: highlighted editing, Markdown and SVG previews, and saves that never overwrite changes made elsewhere. */
export function FileTab({ sessionId, path, line }: { sessionId: string; path: string; line?: number }) {
  useLocale(i18n);
  const [file, setFile] = useState<FileRead>(), [draft, setDraft] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const text = file?.kind === 'text' ? file : undefined, dirty = !!text && draft !== text.content;
  const latest = useRef({ file, dirty, busy });
  latest.current = { file, dirty, busy };
  const load = useCallback(async (signal?: AbortSignal, expectedFile?: FileRead) => {
    const value = await fileRequest<FileRead>('read', { sessionId, path }, signal);
    if (!alive.current || signal?.aborted) return;
    // A background read must not replace edits or a save started while it was in flight.
    if (expectedFile) {
      const now = latest.current;
      if (now.file !== expectedFile) return;
      if (now.dirty) { setStale(true); return; }
      if (now.busy) return;
    }
    setFile(value); setDraft(value.kind === 'text' ? value.content : ''); setStale(false); setError('');
  }, [sessionId, path]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { if (alive.current) setError(localizeError(e)); } finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    const c = new AbortController();
    void load(c.signal).catch(e => { if (!c.signal.aborted) setError(localizeError(e)); });
    return () => c.abort();
  }, [load]);
  // A file changed elsewhere reloads by itself, unless it has unsaved edits: those are kept and the change is reported.
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const c = new AbortController();
    const check = async () => {
      const { file: current, busy: working } = latest.current;
      if (current && !working && document.visibilityState === 'visible') {
        const state = await fileRequest<FileState>('stat', { sessionId, path }, c.signal).catch(() => undefined);
        const now = latest.current;
        if (!stopped && state && now.file === current && !now.busy && (state.mtimeMs !== current.mtimeMs || state.size !== current.size)) {
          if (now.dirty) setStale(true); else await load(c.signal, current).catch(() => {});
        }
      }
      if (!stopped) timer = setTimeout(check, POLL_MS);
    };
    timer = setTimeout(check, POLL_MS);
    return () => { stopped = true; c.abort(); clearTimeout(timer); };
  }, [sessionId, path, load]);
  const save = () => { if (text && dirty) void run(async () => {
    try {
      const saved = await fileRequest<Saved>('write', { sessionId, path, content: draft, revision: text.revision });
      if (alive.current) setFile({ ...text, ...saved, content: draft });
    } catch (e) {
      if ((e as { status?: number }).status === 409) setStale(true);
      throw e;
    }
  }); };
  const previewable = !!text && (isMarkdown(path) || !!imageType(path));
  const svg = useMemo(() => text && mode === 'preview' && imageType(path) ? URL.createObjectURL(new Blob([draft], { type: 'image/svg+xml' })) : undefined, [text, mode, draft, path]);
  useEffect(() => () => { if (svg) URL.revokeObjectURL(svg); }, [svg]);
  const name = path.split('/').pop() ?? path;

  return <section className="fe-tab" aria-label={name}><style>{styles}</style>
    <header className="fe-head">
      <span className="fe-path" title={path}>{path}</span>
      {dirty && <span className="fe-dirty">{ui('Unsaved')}</span>}
      {previewable && <span className="fe-segment" role="radiogroup" aria-label={ui('File view')}>
        {(['edit', 'preview'] as const).map(key => <button type="button" role="radio" key={key} aria-checked={mode === key} onClick={() => setMode(key)}>{ui(key === 'edit' ? 'Edit' : 'Preview')}</button>)}
      </span>}
      {text && <>
        <button type="button" className="fe-button fe-primary" title="⌘/Ctrl + S" disabled={busy || !dirty} onClick={save}>{ui('Save')}</button>
        <button type="button" className="fe-button" disabled={busy || !dirty} onClick={() => { setDraft(text.content); setError(''); }}>{ui('Revert')}</button>
      </>}
      <button type="button" className="fe-button" disabled={busy || (dirty && !stale)} onClick={() => void run(() => load())}>{ui('Reload')}</button>
    </header>
    {stale && <div className="fe-banner" data-tone="warn" role="status"><span>{ui('The file changed on disk.')} {dirty && ui('Reload to see the new version; your unsaved changes will be lost.')}</span></div>}
    {error && <div className="fe-banner" data-tone="error" role="alert">{error}</div>}
    <div className="fe-body">
      {!file ? !error && <p className="fe-note" role="status">{ui('Loading file…')}</p>
        : file.kind === 'binary' ? <p className="fe-note">{ui('This file is not UTF-8 text, so it cannot be edited here.')}</p>
        : file.kind === 'large' ? <p className="fe-note">{ui('This file is larger than the 4 MB editor limit.')}</p>
        : mode === 'preview' && previewable ? (svg ? <ImagePreview src={svg} name={name} labels={{ fit: ui('Fit to pane'), actual: ui('Actual size') }} /> : <MarkdownPreview source={draft} />)
        : <CodeEditor className="fe-editor" label={ui('File contents')} src={EDITOR_SRC} locale={i18n.activeLocale()} path={path} value={draft} onChange={setDraft} onSave={save} readOnly={busy} line={line} />}
    </div>
  </section>;
}
