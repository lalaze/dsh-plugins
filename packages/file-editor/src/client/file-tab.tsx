import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import { CodeEditor, ImagePreview, MarkdownPreview, imageType, isMarkdown } from '@dsh-plugins/file-view';
import { EDITOR_SRC, fileRequest, type FileRead, type FileState, type Saved } from './api.js';
import { i18n, localizeError, ui } from './i18n.js';
import { styles } from './styles.js';

const PATHS = {
  file: 'M4 2h5l3 3v9H4zM9 2v3h3', preview: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  save: 'M3 2.5h8l2.5 2.5v8.5h-10.5zM5.5 2.5V6h5V2.5M5.5 13.5V9.5h5v4', revert: 'M3.5 6.5h6.5a3.5 3.5 0 0 1 0 7H6.5M6 4 3.5 6.5 6 9',
  reload: 'M13 3v3.5H9.5M3 13V9.5h3.5M4.2 6A4.5 4.5 0 0 1 12.6 5.7M11.8 10A4.5 4.5 0 0 1 3.4 10.3',
} as const;
const Icon = ({ kind }: { kind: keyof typeof PATHS }) => <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[kind]} /></svg>;
/** An icon button of the title bar, named by its tooltip. */
const Tool = ({ label, icon, ...props }: { label: string; icon: keyof typeof PATHS } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" className="fe-tool" title={label} aria-label={label} {...props}><Icon kind={icon} /></button>;

/** How often an open file is checked for changes made elsewhere, such as by an agent. */
const POLL_MS = 2000;

/**
 * One local file, edge to edge as an editor in VS Code: a title bar with the path and icon actions, then the editor or a
 * Markdown or SVG preview. Saves never overwrite changes made elsewhere.
 */
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
      <Icon kind="file" /><span className="fe-path" title={path}>{path}</span>
      {dirty && <span className="fe-dirty" role="img" title={ui('Unsaved')} aria-label={ui('Unsaved')} />}
      <span className="fe-tools">
        {previewable && <Tool label={ui('Preview')} icon="preview" aria-pressed={mode === 'preview'} onClick={() => setMode(mode === 'preview' ? 'edit' : 'preview')} />}
        {text && <>
          <Tool label={ui('Save')} icon="save" title={`${ui('Save')} (⌘/Ctrl+S)`} disabled={busy || !dirty} onClick={save} />
          <Tool label={ui('Revert')} icon="revert" disabled={busy || !dirty} onClick={() => { setDraft(text.content); setError(''); }} />
        </>}
        <Tool label={ui('Reload')} icon="reload" disabled={busy || (dirty && !stale)} onClick={() => void run(() => load())} />
      </span>
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
