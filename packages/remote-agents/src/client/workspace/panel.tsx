import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor, ImagePreview, MarkdownPreview, imageType, isMarkdown } from '@dsh-plugins/file-view';
import { api, EDITOR_SRC, requestId } from '../api.js';
import { i18n, ui, localizeError, useLocale } from '../i18n.js';
import { workspaceStyles } from './styles.js';
import { type SyncResult, type Tunnel, type WorkspaceEntry, type WorkspaceFile, type WorkspaceTarget } from '../../workspace/domain.js';

const TOOLS = { files: 'Files', sync: 'Sync', tunnels: 'Tunnels', web: 'Remote DSH' } as const;
export type WorkspaceTool = keyof typeof TOOLS;
const ALL_TOOLS = Object.keys(TOOLS) as WorkspaceTool[];
/**
 * The address this browser reaches DSH at. Local tunnels listen on every interface of the DSH machine, so their links
 * use it too, and a managed remote DSH must trust it as the Host header those links send.
 */
const accessHost = () => /^https?:$/.test(location.protocol) && location.hostname ? location.hostname : 'localhost';
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const PATHS = {
  server: 'M3 4.5h10v3H3zM3 8.5h10v3H3zM5 6h.01M5 10h.01', folder: 'M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3', up: 'M8 13V3M4 7l4-4 4 4', plus: 'M8 3v10M3 8h10', upload: 'M8 10V2.5M5 5.5l3-3 3 3M3 10v3h10v-3',
  download: 'M8 2.5V10M5 7l3 3 3-3M3 10v3h10v-3', refresh: 'M13 3v3.5H9.5M3 13V9.5h3.5M4.2 6A4.5 4.5 0 0 1 12.6 5.7M11.8 10A4.5 4.5 0 0 1 3.4 10.3',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5', trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5', play: 'M5 3.5v9l7-4.5z',
  stop: 'M4.5 4.5h7v7h-7z', close: 'M4.5 4.5l7 7M11.5 4.5l-7 7', external: 'M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5',
  save: 'M3 2.5h8l2.5 2.5v8.5h-10.5zM5.5 2.5V6h5V2.5M5.5 13.5V9.5h5v4', discard: 'M3.5 6.5h6.5a3.5 3.5 0 0 1 0 7H6.5M6 4 3.5 6.5 6 9',
  rename: 'M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3', preview: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  check: 'M3 8.5l3 3 7-7',
} as const;
function Icon({ kind }: { kind: keyof typeof PATHS }) {
  return <svg className="ra-ws-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[kind]} /></svg>;
}

/**
 * The remote workspace tools; `tools` narrows them, and a single tool shows without the tool tabs. With `openFile`, the
 * files tool is only a file list and opening a file calls it, as a sidebar opens a tab; `fileOnly` shows only the
 * `initialPath` file, at `line`. Otherwise the list and the open file share the panel.
 */
export function WorkspacePanel({ sessionId, initialPath, tools = ALL_TOOLS, openFile, fileOnly = false, line }: {
  sessionId?: string; initialPath?: string; tools?: readonly WorkspaceTool[]; openFile?: (path: string) => void; fileOnly?: boolean; line?: number;
}) {
  useLocale();
  const [target, setTarget] = useState<WorkspaceTarget>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<WorkspaceTool>(tools[0] ?? 'files'), [path, setPath] = useState(''), [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState<string>(), [file, setFile] = useState<WorkspaceFile>(), [draft, setDraft] = useState('');
  // Rename, delete and download need only the revision; text editing additionally needs readable content.
  const [info, setInfo] = useState<{ path: string; revision: string; size: number }>(), [readOnly, setReadOnly] = useState('');
  // Markdown and SVG files can also be shown rendered; binary images are only shown.
  const [mode, setMode] = useState<'edit' | 'preview'>('edit'), [picture, setPicture] = useState<string>(), [removed, setRemoved] = useState(false);
  const [name, setName] = useState(''), [kind, setKind] = useState<'file' | 'directory'>('file'), [deleting, setDeleting] = useState(false), [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<{ path: string; line: number; text: string }[]>();
  const [direction, setDirection] = useState<'pull' | 'push'>('pull'), [sync, setSync] = useState<SyncResult>();
  const [tunnels, setTunnels] = useState<Tunnel[]>([]), [listenPort, setListenPort] = useState('38080'), [targetPort, setTargetPort] = useState('3000'), [tunnelDirection, setTunnelDirection] = useState<'local' | 'reverse'>('local');
  const [webPort, setWebPort] = useState('3080'), [webLocalPort, setWebLocalPort] = useState('38088'), [webUrl, setWebUrl] = useState(''), [webLink, setWebLink] = useState('');
  const abort = useRef(new AbortController()), input = useRef<HTMLInputElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current.abort(); }; }, []);
  useEffect(() => {
    if (!sessionId) return;
    const c = new AbortController();
    void api<WorkspaceTarget>('workspaceTarget', { sessionId }, c.signal).then(value => { if (!c.signal.aborted) setTarget(value); })
      .catch(e => { if (!c.signal.aborted) setError(localizeError(e)); });
    return () => c.abort();
  }, [sessionId]);
  const call = useCallback(<T,>(action: string, data: Record<string, unknown> = {}, signal = abort.current.signal) => api<T>(action, { sessionId, target, ...data }, signal), [sessionId, target]);
  const operate = useCallback(<T,>(operation: object) => call<T>('workspaceFiles', { operation }), [call]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('');
    try { await action(); } catch (e) { if (alive.current) setError(localizeError(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  const reload = useCallback(async () => {
    const value = await operate<{ entries: WorkspaceEntry[] }>({ op: 'list', path: path || '.' });
    if (alive.current) setEntries(value.entries);
  }, [operate, path]);
  useEffect(() => {
    if (!target) return;
    const c = new AbortController();
    void call<{ entries: WorkspaceEntry[] }>('workspaceFiles', { operation: { op: 'list', path: path || '.' } }, c.signal)
      .then(v => { if (!c.signal.aborted) setEntries(v.entries); }).catch(e => { if (!c.signal.aborted) setError(localizeError(e)); });
    return () => c.abort();
  }, [target, path, call]);
  const open = useCallback(async (filePath: string) => {
    setSelected(filePath); setFile(undefined); setInfo(undefined); setReadOnly(''); setDraft(''); setDeleting(false); setRenaming(false); setMode('edit');
    try {
      const value = await operate<WorkspaceFile>({ op: 'read', path: filePath });
      if (alive.current) { setFile(value); setInfo(value); setDraft(value.content); }
    } catch (error) {
      // Binary, non-UTF-8 and large files cannot be edited here, but they can still be renamed, deleted and downloaded.
      const value = await operate<{ path: string; revision: string | null; size: number }>({ op: 'stat', path: filePath }).catch(() => undefined);
      if (!value?.revision) throw error;
      if (alive.current) { setInfo({ ...value, revision: value.revision }); setReadOnly(localizeError(error)); }
    }
  }, [operate]);
  useEffect(() => { if (target && initialPath) void open(initialPath).catch(e => setError(localizeError(e))); }, [target, initialPath, open]);
  const dirty = !!file && draft !== file.content;
  /** A file chosen in the list opens in its own tab when the host offers one, and here otherwise. */
  const pick = (filePath: string) => { if (openFile) openFile(filePath); else if (canNavigate()) void run(() => open(filePath)); };
  const canNavigate = () => { if (!dirty) return true; setError(ui('Save or discard your changes before opening another file.')); return false; };
  const fileRevision = async (p: string) => (await operate<{ revision: string; size: number }>({ op: 'stat', path: p }));
  // Downloads and uploads use separate routes: see the workspace install module.
  const urlFor = (p: string, rev?: string) => (rev ? '/api/remote-agents/download?' : '/api/remote-agents/files?') + new URLSearchParams({ sessionId: sessionId!, hostId: target!.hostId, cwd: target!.cwd, path: p, ...(rev ? { revision: rev } : {}) });
  /** A failed transfer's message; a failure before the plugin answers has no JSON body. */
  const transferError = async (response: Response) => new Error((await response.json().catch(() => undefined) as { error?: string } | undefined)?.error ?? ui('File transfer failed ({status})', { status: response.status }));
  const download = async () => {
    if (!selected) return;
    const info = await fileRevision(selected), response = await fetch(urlFor(selected, info.revision), { headers: { 'X-DSH-Remote-Agents': '1' }, signal: abort.current.signal });
    if (!response.ok) throw await transferError(response);
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = selected.split('/').pop() || 'file'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  useEffect(() => {
    if (!target || tab !== 'tunnels') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const value = await call<Tunnel[]>('workspaceTunnels'); if (!stopped) setTunnels(value); } catch (e) { if (!stopped) setError(localizeError(e)); } if (!stopped) timer = setTimeout(() => void poll(), 3000); };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [target, tab, call]);
  /** Forwards a remote loopback DSH login URL and shows the local link; starting the managed instance calls it too. */
  const connectWeb = async (url: string) => {
    const remote = new URL(url);
    if (remote.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(remote.hostname) || remote.username || remote.password || !remote.port) throw new Error(ui('Enter the remote loopback DSH login URL.'));
    const listenPort = Number(webLocalPort), targetPort = Number(remote.port);
    // Reconnecting reuses the saved tunnel for this port pair; starting one that already runs returns it unchanged.
    const saved = (await call<Tunnel[]>('workspaceTunnels')).find(t => t.direction === 'local' && t.listenPort === listenPort && t.targetHost === '127.0.0.1' && t.targetPort === targetPort);
    const id = saved?.id ?? requestId();
    if (!saved) await call('addWorkspaceTunnel', { tunnel: { id, direction: 'local', listenPort, targetPort, targetHost: '127.0.0.1' } });
    await call('startWorkspaceTunnel', { id });
    if (alive.current) setWebLink(`http://${accessHost()}:${listenPort}${remote.pathname}${remote.search}`);
  };
  // A binary image is fetched at the revision just read; an SVG previews the text being edited.
  const binaryImage = !file && info && imageType(info.path) ? info : undefined;
  useEffect(() => {
    if (!binaryImage || !target || !sessionId) return;
    const c = new AbortController();
    let url: string | undefined;
    void fetch(urlFor(binaryImage.path, binaryImage.revision), { headers: { 'X-DSH-Remote-Agents': '1' }, signal: c.signal })
      .then(async response => { if (!response.ok) throw await transferError(response); return response.blob(); })
      .then(blob => { if (!c.signal.aborted) { url = URL.createObjectURL(blob); setPicture(url); } })
      .catch(e => { if (!c.signal.aborted) setError(localizeError(e)); });
    return () => { c.abort(); if (url) URL.revokeObjectURL(url); setPicture(undefined); };
  }, [binaryImage?.path, binaryImage?.revision, target, sessionId]);
  const svg = useMemo(() => file && mode === 'preview' && imageType(file.path) ? URL.createObjectURL(new Blob([draft], { type: 'image/svg+xml' })) : undefined, [file, mode, draft]);
  useEffect(() => () => { if (svg) URL.revokeObjectURL(svg); }, [svg]);
  const previewable = !!file && (isMarkdown(file.path) || !!imageType(file.path));
  const tunnelAction = async (action: string, id: string) => { await call(action, { id }); setTunnels(await call<Tunnel[]>('workspaceTunnels')); };

  const folders = path ? path.split('/') : [];
  // Browsing folders leaves the open file and its unsaved edits alone.
  const goTo = (next: string) => { setPath(next); setMatches(undefined); };
  const clearSearch = () => { setQuery(''); setMatches(undefined); };
  const close = () => { if (canNavigate()) { setSelected(undefined); setFile(undefined); setInfo(undefined); setReadOnly(''); setDraft(''); setDeleting(false); setError(''); } };
  const save = () => { if (file && dirty) void run(async () => { const saved = await operate<{ path: string; revision: string; size: number }>({ op: 'write', path: file.path, content: draft, revision: file.revision }); setFile({ ...file, ...saved, content: draft }); setInfo(saved); await reload(); }); };
  const rename = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const destination = (new FormData(event.currentTarget).get('destination') as string).trim();
    if (!info || !destination || destination === info.path) { setRenaming(false); return; }
    void run(async () => { await operate({ op: 'move', path: info.path, destination, revision: info.revision }); await reload(); await open(destination); });
  };
  const create = (event: React.FormEvent) => { event.preventDefault(); void run(async () => {
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error(ui('Enter a file or folder name.'));
    const destination = path ? `${path}/${name}` : name;
    await operate(kind === 'directory' ? { op: 'mkdir', path: destination } : { op: 'write', path: destination, content: '', revision: null }); setName(''); setCreating(false); await reload();
    if (kind === 'file') { if (openFile) openFile(destination); else if (!dirty) await open(destination); }
  }); };
  const upload = (event: React.ChangeEvent<HTMLInputElement>) => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) void run(async () => {
    if (chosen.size > 50 * 1024 * 1024) throw new Error(ui('File exceeds the 50 MB transfer limit'));
    const destination = path ? `${path}/${chosen.name}` : chosen.name;
    if (entries.some(e => e.path === destination)) throw new Error(ui('A file with that name already exists. Rename it before uploading.'));
    const response = await fetch(urlFor(destination), { method: 'POST', headers: { 'X-DSH-Remote-Agents': '1', 'X-File-Size': String(chosen.size), 'X-File-Revision': 'new' }, body: chosen, signal: abort.current.signal });
    if (!response.ok) throw await transferError(response); await reload();
  }); };
  const segmented = <T extends string,>(label: string, value: T, set: (value: T) => void, options: readonly (readonly [T, string])[]) =>
    <div className="ra-ws-segment" role="radiogroup" aria-label={label}>{options.map(([key, text]) => <button type="button" role="radio" key={key} aria-checked={value === key} disabled={busy} onClick={() => set(key)}>{text}</button>)}</div>;

  return <section className="dsh-ra ra-workspace-panel" aria-label={ui('Remote workspace')} data-file-only={fileOnly ? '' : undefined}><style>{workspaceStyles}</style>
    {!fileOnly && <header className="ra-ws-head">
      {target ? <span className="ra-ws-target" title={`${target.label}:${target.cwd}`}><Icon kind="server" /><b>{target.label}</b><span className="ra-mono">{`\u200e${target.cwd}\u200e`}</span></span> : <span />}
      {busy && <span className="ra-ws-busy" role="status"><span className="ra-ws-spinner" aria-hidden="true" />{ui('Working…')}</span>}
    </header>}
    {!sessionId ? <p className="ra-ws-note">{ui('Select a verified remote workspace first.')}</p> : !target ? <p className="ra-ws-note" role="status">{error || ui('Loading workspace…')}</p> : <>
      {tools.length > 1 && <nav className="ra-ws-tabs" aria-label={ui('Workspace tools')}>{tools.map(key => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{ui(TOOLS[key])}</button>)}</nav>}
      {error && <div className="ra-banner" data-tone="error" role="alert"><span>{error}</span>{selected && tab === 'files' && <button disabled={busy} onClick={() => void run(() => open(selected))}>{ui('Reload file')}</button>}</div>}
      {tab === 'files' && <div className="ra-ws-files" data-layout={openFile ? 'list' : fileOnly ? 'file' : undefined} data-open={selected && !openFile && !fileOnly ? '' : undefined}>
        {!fileOnly && <aside className="ra-ws-browser">
          <div className="ra-ws-toolbar">
            <button type="button" className="ra-ws-icon" title={ui('Up')} aria-label={ui('Up')} disabled={busy || !path} onClick={() => goTo(folders.slice(0, -1).join('/'))}><Icon kind="up" /></button>
            <nav className="ra-ws-crumbs" aria-label={ui('Folder')}><button type="button" disabled={busy || !path} onClick={() => goTo('')}>{target.cwd.split('/').filter(Boolean).pop() ?? '/'}</button>
              {folders.map((folder, index) => <React.Fragment key={index}><span aria-hidden="true">/</span><button type="button" disabled={busy || index === folders.length - 1} onClick={() => goTo(folders.slice(0, index + 1).join('/'))}>{folder}</button></React.Fragment>)}</nav>
            <button type="button" className="ra-ws-icon" title={ui('New file or folder')} aria-label={ui('New file or folder')} aria-expanded={creating} disabled={busy} onClick={() => setCreating(!creating)}><Icon kind="plus" /></button>
            <button type="button" className="ra-ws-icon" title={ui('Upload file')} aria-label={ui('Upload file')} disabled={busy} onClick={() => input.current?.click()}><Icon kind="upload" /></button>
            <button type="button" className="ra-ws-icon" title={ui('Refresh')} aria-label={ui('Refresh')} disabled={busy} onClick={() => void run(reload)}><Icon kind="refresh" /></button>
          </div>
          {creating && <form className="ra-ws-inline" onSubmit={create}>
            {segmented(ui('New item type'), kind, setKind, [['file', ui('File')], ['directory', ui('Folder')]] as const)}
            <input className="ra-ws-input" aria-label={ui('New item name')} placeholder={ui(kind === 'directory' ? 'Folder' : 'File')} autoFocus value={name} onChange={e => setName(e.target.value)} />
            <button className="ra-ws-button ra-primary" disabled={busy || !name}>{ui('Create')}</button>
          </form>}
          <form className="ra-ws-search" onSubmit={event => { event.preventDefault(); void run(async () => { const value = await operate<{ matches: typeof matches }>({ op: 'search', path: '.', query }); setMatches(value.matches); }); }}>
            <Icon kind="search" /><input aria-label={ui('Search remote files')} placeholder={ui('Search remote files')} value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value) setMatches(undefined); }} onKeyDown={e => { if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); clearSearch(); } }} />
            {query && <button type="button" className="ra-ws-icon" title={ui('Clear search')} aria-label={ui('Clear search')} onClick={clearSearch}><Icon kind="close" /></button>}
          </form>
          <div className="ra-ws-entries">{matches ? (matches.length ? matches.map((match, index) => <button type="button" key={index} disabled={busy} aria-pressed={selected === match.path} onClick={() => pick(match.path)}>
              <Icon kind="file" /><span className="ra-ws-entry-name">{match.path}<small>{match.line}: {match.text}</small></span></button>) : <p className="ra-ws-empty">{ui('No matches')}</p>)
            : entries.length ? entries.map(entry => <button type="button" key={entry.path} data-kind={entry.kind} disabled={busy || !['directory', 'file'].includes(entry.kind)} aria-pressed={selected === entry.path} onClick={() => {
              if (entry.kind === 'directory') goTo(entry.path);
              else pick(entry.path);
            }}><Icon kind={entry.kind === 'directory' ? 'folder' : 'file'} /><span className="ra-ws-entry-name">{entry.name}</span>{entry.kind === 'file' ? <small>{size(entry.size)}</small> : entry.kind !== 'directory' && <small>{ui(entry.kind)}</small>}</button>)
            : <p className="ra-ws-empty">{ui('This folder is empty')}</p>}</div>
          <input hidden type="file" ref={input} onChange={upload} />
        </aside>}
        {!openFile && <main className="ra-ws-viewer">
          {selected ? <>
            <div className="ra-ws-viewer-head">
              {fileOnly ? <><Icon kind="server" /><span className="ra-ws-host" title={`${target.label}:${target.cwd}`}>{target.label}</span><span className="ra-ws-sep" aria-hidden="true">›</span></> : <Icon kind="file" />}
              {renaming && info ? <form className="ra-ws-rename" onSubmit={rename}>
                <input className="ra-ws-input" name="destination" aria-label={ui('Rename destination')} defaultValue={info.path} autoFocus
                  onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(false); } }} />
                <button type="submit" className="ra-ws-icon" title={ui('Rename')} aria-label={ui('Rename')} disabled={busy}><Icon kind="check" /></button>
                <button type="button" className="ra-ws-icon" title={ui('Cancel')} aria-label={ui('Cancel')} onClick={() => setRenaming(false)}><Icon kind="close" /></button>
              </form> : <span className="ra-mono" title={selected}>{selected}</span>}
              {dirty && <span className="ra-ws-dirty" role="img" title={ui('Unsaved')} aria-label={ui('Unsaved')} />}
              {fileOnly && busy && <span className="ra-ws-spinner" role="status" title={ui('Working…')} aria-label={ui('Working…')} />}
              <span className="ra-ws-tools">
                {previewable && <button type="button" className="ra-ws-icon" title={ui('Preview')} aria-label={ui('Preview')} aria-pressed={mode === 'preview'} disabled={busy} onClick={() => setMode(mode === 'preview' ? 'edit' : 'preview')}><Icon kind="preview" /></button>}
                {file && <button type="button" className="ra-ws-icon" title={`${ui('Save to remote')} (⌘/Ctrl+S)`} aria-label={ui('Save to remote')} disabled={busy || !dirty} onClick={save}><Icon kind="save" /></button>}
                {file && <button type="button" className="ra-ws-icon" title={ui('Discard changes')} aria-label={ui('Discard changes')} disabled={busy || !dirty} onClick={() => { setDraft(file.content); setError(''); }}><Icon kind="discard" /></button>}
                {info && <button type="button" className="ra-ws-icon" title={ui('Rename')} aria-label={ui('Rename')} aria-expanded={renaming} disabled={busy || dirty} onClick={() => setRenaming(!renaming)}><Icon kind="rename" /></button>}
                <button type="button" className="ra-ws-icon" title={ui('Download')} aria-label={ui('Download')} disabled={busy} onClick={() => void run(download)}><Icon kind="download" /></button>
                {info && <button type="button" className="ra-ws-icon ra-ws-danger" title={ui('Delete file')} aria-label={ui('Delete file')} disabled={busy} onClick={() => setDeleting(true)}><Icon kind="trash" /></button>}
                {!fileOnly && <button type="button" className="ra-ws-icon" title={ui('Close file')} aria-label={ui('Close file')} disabled={busy} onClick={close}><Icon kind="close" /></button>}
              </span>
            </div>
            {readOnly && !binaryImage && <p className="ra-ws-note">{readOnly}</p>}
            {binaryImage && (picture ? <div className="ra-ws-preview"><ImagePreview src={picture} name={binaryImage.path.split('/').pop() ?? ''} bytes={binaryImage.size} labels={{ fit: ui('Fit to pane'), actual: ui('Actual size') }} /></div>
              : <p className="ra-ws-note" role="status">{ui('Loading image…')}</p>)}
            {file && mode === 'preview' && (svg ? <div className="ra-ws-preview"><ImagePreview src={svg} name={file.path.split('/').pop() ?? ''} labels={{ fit: ui('Fit to pane'), actual: ui('Actual size') }} /></div>
              : <MarkdownPreview className="ra-ws-preview" source={draft} />)}
            {file && mode === 'edit' && <CodeEditor key={file.path} className="ra-workspace-editor" label={ui('Remote file contents')} src={EDITOR_SRC} locale={i18n.activeLocale()} path={file.path} value={draft} onChange={setDraft} onSave={save} readOnly={busy} line={file.path === initialPath ? line : undefined} />}
            {deleting && info && <div className="ra-banner" data-tone="error"><span>{ui('Delete this remote file?')}</span><span className="ra-ws-row"><button disabled={busy} onClick={() => void run(async () => { await operate({ op: 'remove', path: info.path, revision: info.revision }); setFile(undefined); setInfo(undefined); setReadOnly(''); setSelected(undefined); setDeleting(false); setRemoved(true); await reload(); })}>{ui('Delete')}</button><button onClick={() => setDeleting(false)}>{ui('Cancel')}</button></span></div>}
          </> : fileOnly ? <div className="ra-ws-placeholder"><Icon kind="file" /><p>{ui(removed ? 'File deleted' : 'Loading file…')}</p></div>
            : <div className="ra-ws-placeholder"><Icon kind="file" /><p>{ui('Choose a file')}</p><small>{ui('Files are read directly from the remote machine. Saving checks for concurrent edits.')}</small></div>}
        </main>}
      </div>}
      {tab === 'sync' && <div className="ra-ws-section">
        <p className="ra-ws-note">{ui('Sync the remote directory and its local workspace mirror. Preview first; files changed on both sides are preserved as conflicts. Git, dependencies and symbolic links are skipped.')}</p>
        <div className="ra-ws-card">
          {segmented(ui('Sync direction'), direction, value => { setDirection(value); setSync(undefined); }, [['pull', ui('Pull remote → local mirror')], ['push', ui('Push local mirror → remote')]] as const)}
          <div className="ra-ws-card-foot"><button className="ra-ws-button" disabled={busy} onClick={() => void run(async () => setSync(await call<SyncResult>('workspaceSync', { direction })))}>{ui('Preview sync')}</button>
            <button className="ra-ws-button ra-primary" disabled={busy || !sync?.dryRun} onClick={() => void run(async () => setSync(await call<SyncResult>('workspaceSync', { direction, apply: true, planId: sync!.planId })))}>{ui('Apply preview')}</button></div>
        </div>
        {sync && <div className="ra-ws-card">
          <p className="ra-ws-card-title" role="status">{ui(sync.dryRun ? 'Sync preview' : 'Sync completed')}<span>{sync.changes.length} {ui('changes')} · {sync.conflicts.length} {ui('conflicts')}</span></p>
          {sync.changes.length + sync.conflicts.length > 0 ? <ul className="ra-ws-list">{sync.changes.map(c => <li key={c.path}><span className="ra-ws-tag" data-action={c.action}>{ui(c.action)}</span><span className="ra-mono">{c.path}</span></li>)}
            {sync.conflicts.map(p => <li key={p}><span className="ra-ws-tag" data-action="conflict">{ui('Conflict')}</span><span className="ra-mono">{p}</span></li>)}</ul> : <p className="ra-ws-empty">{ui('Nothing to sync')}</p>}
          {sync.skipped.length > 0 && <details className="ra-ws-skipped"><summary>{ui('Skipped files')} ({sync.skipped.length})</summary><pre>{sync.skipped.join('\n')}</pre></details>}
        </div>}
      </div>}
      {tab === 'tunnels' && <div className="ra-ws-section">
        <p className="ra-ws-note">{ui('Forward application ports or a running remote DSH web interface. Tunnels stop when DSH closes; saved definitions remain. Agent sessions keep running independently.')}</p>
        <form className="ra-ws-card" onSubmit={event => { event.preventDefault(); void run(async () => { const id = requestId();
          // A new tunnel starts right away; if starting fails it stays saved with the error, ready to retry.
          await call('addWorkspaceTunnel', { tunnel: { id, direction: tunnelDirection, listenPort: Number(listenPort), targetPort: Number(targetPort), targetHost: '127.0.0.1' } });
          try { await call('startWorkspaceTunnel', { id }); } finally { setTunnels(await call<Tunnel[]>('workspaceTunnels')); } }); }}>
          {segmented(ui('Direction'), tunnelDirection, setTunnelDirection, [['local', ui('Local → remote')], ['reverse', ui('Remote → local')]] as const)}
          <div className="ra-ws-ports"><label className="ra-ws-field">{ui('Listen port')}<input className="ra-ws-input" type="number" min="1" max="65535" required value={listenPort} onChange={e => setListenPort(e.target.value)} /></label>
            <span className="ra-ws-arrow" aria-hidden="true">→</span>
            <label className="ra-ws-field">{ui('Target port')}<input className="ra-ws-input" type="number" min="1" max="65535" required value={targetPort} onChange={e => setTargetPort(e.target.value)} /></label>
            <button className="ra-ws-button ra-primary" disabled={busy}><Icon kind="plus" />{ui('Add and start')}</button></div>
        </form>
        <h3 className="ra-ws-subhead">{ui('Saved tunnels')}{tunnels.length > 0 && <span>{tunnels.length}</span>}</h3>
        {tunnels.length ? <ul className="ra-ws-tunnels">{tunnels.map(t => <li key={t.id} data-status={t.status}>
          <span className="ra-ws-dot" aria-hidden="true" />
          <div className="ra-ws-tunnel-main"><span className="ra-mono">{t.listenPort} → {t.targetHost}:{t.targetPort}</span><small>{ui(t.direction === 'local' ? 'Local → remote' : 'Remote → local')} · {ui(t.status)}</small>{t.error && <small className="ra-ws-error" role="alert">{t.error}</small>}</div>
          <div className="ra-ws-row">{t.status === 'running' && t.direction === 'local' && <a className="ra-ws-icon" href={`http://${accessHost()}:${t.listenPort}`} target="_blank" rel="noreferrer" title={ui('Open')} aria-label={ui('Open')}><Icon kind="external" /></a>}
            <button type="button" className="ra-ws-icon" title={ui(t.status === 'running' ? 'Stop' : 'Start')} aria-label={ui(t.status === 'running' ? 'Stop' : 'Start')} disabled={busy} onClick={() => void run(() => tunnelAction(t.status === 'running' ? 'stopWorkspaceTunnel' : 'startWorkspaceTunnel', t.id))}><Icon kind={t.status === 'running' ? 'stop' : 'play'} /></button>
            <button type="button" className="ra-ws-icon ra-ws-danger" title={ui('Remove')} aria-label={ui('Remove')} disabled={busy} onClick={() => void run(() => tunnelAction('removeWorkspaceTunnel', t.id))}><Icon kind="trash" /></button></div>
        </li>)}</ul> : <p className="ra-ws-empty">{ui('No tunnels yet. Add one above.')}</p>}
      </div>}
      {tab === 'web' && <div className="ra-ws-section">
        <p className="ra-ws-note">{ui('Open the remote machine’s DSH interface through SSH. Starting an instance uses an isolated DSH home and requires dsh on the remote login PATH. Closing the tunnel leaves that instance running.')}</p>
        <div className="ra-ws-card"><p className="ra-ws-card-title">{ui('Managed instance')}</p>
          <div className="ra-ws-ports"><label className="ra-ws-field">{ui('Remote DSH port')}<input className="ra-ws-input" aria-label={ui('Remote DSH port')} type="number" min="1024" max="65535" value={webPort} onChange={e => setWebPort(e.target.value)} /></label>
            <button className="ra-ws-button ra-primary" disabled={busy} onClick={() => void run(async () => { const result = await operate<{ url: string }>({ op: 'webStart', path: '.', port: Number(webPort), host: accessHost() }); setWebUrl(result.url); setWebLink(''); await connectWeb(result.url); })}><Icon kind="play" />{ui('Start remote DSH')}</button>
            <button className="ra-ws-button" disabled={busy} onClick={() => void run(async () => { await operate({ op: 'webStop', path: '.', port: Number(webPort) }); setWebUrl(''); setWebLink(''); })}>{ui('Stop managed instance')}</button></div>
        </div>
        <form className="ra-ws-card" onSubmit={event => { event.preventDefault(); void run(() => connectWeb(webUrl)); }}><p className="ra-ws-card-title">{ui('Connect remote DSH')}</p>
          <label className="ra-ws-field">{ui('Remote login URL')}<input className="ra-ws-input" aria-label={ui('Remote login URL')} type="password" autoComplete="off" value={webUrl} onChange={e => { setWebUrl(e.target.value); setWebLink(''); }} placeholder="http://127.0.0.1:3080/?token=…" /></label>
          <div className="ra-ws-ports"><label className="ra-ws-field">{ui('Local DSH port')}<input className="ra-ws-input" type="number" min="1" max="65535" value={webLocalPort} onChange={e => setWebLocalPort(e.target.value)} /></label>
            <button className="ra-ws-button ra-primary" disabled={busy || !webUrl}>{ui('Connect remote DSH')}</button>
            {webLink && <a className="ra-ws-button" href={webLink} target="_blank" rel="noreferrer"><Icon kind="external" />{ui('Open remote DSH')}</a>}</div>
        </form>
      </div>}
    </>}
  </section>;
}
