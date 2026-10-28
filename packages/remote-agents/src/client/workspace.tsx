import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, requestId } from './api.js';
import { ui, localizeError, useLocale } from './i18n.js';
import { TUNNEL_ACCESS_HOST, type SyncResult, type Tunnel, type WorkspaceEntry, type WorkspaceFile, type WorkspaceTarget } from '../workspace-domain.js';

const TOOLS = { files: 'Files', commands: 'Commands', sync: 'Sync', tunnels: 'Tunnels', web: 'Remote DSH' } as const;
export type WorkspaceTool = keyof typeof TOOLS;
const ALL_TOOLS = Object.keys(TOOLS) as WorkspaceTool[];

/** The remote workspace tools; `tools` narrows them, and a single tool shows without the tool tabs. */
export function WorkspacePanel({ sessionId, initialPath, tools = ALL_TOOLS }: { sessionId?: string; initialPath?: string; tools?: readonly WorkspaceTool[] }) {
  useLocale();
  const [target, setTarget] = useState<WorkspaceTarget>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<WorkspaceTool>(tools[0] ?? 'files'), [path, setPath] = useState(''), [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selected, setSelected] = useState<string>(), [file, setFile] = useState<WorkspaceFile>(), [draft, setDraft] = useState('');
  // Rename, delete and download need only the revision; text editing additionally needs readable content.
  const [info, setInfo] = useState<{ path: string; revision: string; size: number }>(), [readOnly, setReadOnly] = useState('');
  const [name, setName] = useState(''), [kind, setKind] = useState('file'), [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<{ path: string; line: number; text: string }[]>();
  const [command, setCommand] = useState(''), [output, setOutput] = useState('');
  const [direction, setDirection] = useState<'pull' | 'push'>('pull'), [sync, setSync] = useState<SyncResult>();
  const [tunnels, setTunnels] = useState<Tunnel[]>([]), [listenPort, setListenPort] = useState('38080'), [targetPort, setTargetPort] = useState('3000'), [tunnelDirection, setTunnelDirection] = useState('local');
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
    setSelected(filePath); setFile(undefined); setInfo(undefined); setReadOnly(''); setDraft(''); setDeleting(false);
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
  const canNavigate = () => { if (!dirty) return true; setError(ui('Save or discard your changes before opening another file.')); return false; };
  const fileRevision = async (p: string) => (await operate<{ revision: string; size: number }>({ op: 'stat', path: p }));
  const urlFor = (p: string, rev?: string) => '/api/remote-agents/files?' + new URLSearchParams({ sessionId: sessionId!, hostId: target!.hostId, cwd: target!.cwd, path: p, ...(rev ? { revision: rev } : {}) });
  const download = async () => {
    if (!selected) return;
    const info = await fileRevision(selected), response = await fetch(urlFor(selected, info.revision), { headers: { 'X-DSH-Remote-Agents': '1' }, signal: abort.current.signal });
    if (!response.ok) throw new Error((await response.json()).error);
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = selected.split('/').pop() || 'file'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  useEffect(() => {
    if (!target || tab !== 'tunnels') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const value = await call<Tunnel[]>('workspaceTunnels'); if (!stopped) setTunnels(value); } catch (e) { if (!stopped) setError(localizeError(e)); } if (!stopped) timer = setTimeout(() => void poll(), 3000); };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [target, tab, call]);
  const tunnelAction = async (action: string, id: string) => { await call(action, { id }); setTunnels(await call<Tunnel[]>('workspaceTunnels')); };

  return <section className="dsh-ra ra-workspace-panel" aria-label={ui('Remote workspace')}>
    <header><h2>{ui('Remote workspace')}</h2>{target && <p className="ra-mono">{target.label}:{target.cwd}</p>}</header>
    {error && <div className="ra-banner" role="alert">{error}{selected && <button disabled={busy} onClick={() => void run(() => open(selected))}>{ui('Reload file')}</button>}</div>}
    {!sessionId ? <p>{ui('Select a verified remote workspace first.')}</p> : !target ? <p role="status">{ui(error ? 'Select a verified remote workspace first.' : 'Loading workspace…')}</p> : <>
      {tools.length > 1 && <nav className="ra-workspace-tabs" aria-label={ui('Workspace tools')}>{tools.map(key => <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{ui(TOOLS[key])}</button>)}</nav>}
      {tab === 'files' && <div className="ra-workspace-files">
        <aside><div className="ra-actions"><button disabled={busy || !path} onClick={() => { if (canNavigate()) setPath(path.split('/').slice(0, -1).join('/')); }}>{ui('Up')}</button><span className="ra-mono">/{path}</span><button disabled={busy} onClick={() => void run(reload)}>{ui('Refresh')}</button></div>
          <form className="ra-workspace-create" onSubmit={event => { event.preventDefault(); void run(async () => {
            if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error(ui('Enter a file or folder name.'));
            const destination = path ? `${path}/${name}` : name;
            await operate(kind === 'directory' ? { op: 'mkdir', path: destination } : { op: 'write', path: destination, content: '', revision: null }); setName(''); await reload();
          }); }}><select aria-label={ui('New item type')} value={kind} onChange={e => setKind(e.target.value)}><option value="file">{ui('File')}</option><option value="directory">{ui('Folder')}</option></select><input aria-label={ui('New item name')} value={name} onChange={e => setName(e.target.value)} /><button disabled={busy || !name}>{ui('Create')}</button></form>
          <form className="ra-workspace-search" onSubmit={event => { event.preventDefault(); void run(async () => { const value = await operate<{ matches: typeof matches }>({ op: 'search', path: '.', query }); setMatches(value.matches); }); }}><input aria-label={ui('Search remote files')} value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value) setMatches(undefined); }} /><button disabled={busy || !query}>{ui('Search')}</button></form>
          <div className="ra-workspace-entries">{matches ? matches.map((match, index) => <button key={index} disabled={busy} onClick={() => { if (canNavigate()) void run(() => open(match.path)); }}>{match.path}:{match.line}<small>{match.text}</small></button>) : entries.map(entry => <button key={entry.path} disabled={busy || !['directory', 'file'].includes(entry.kind)} aria-pressed={selected === entry.path} onClick={() => {
            if (!canNavigate()) return;
            if (entry.kind === 'directory') { setPath(entry.path); setMatches(undefined); }
            else void run(() => open(entry.path));
          }}><span>{entry.kind === 'directory' ? '▸ ' : ''}{entry.name}</span><small>{entry.kind === 'file' ? `${entry.size} B` : ui(entry.kind)}</small></button>)}</div>
          <input hidden type="file" ref={input} onChange={event => { const upload = event.target.files?.[0]; event.target.value = ''; if (upload) void run(async () => {
            if (upload.size > 50 * 1024 * 1024) throw new Error(ui('File exceeds the 50 MB transfer limit'));
            const destination = path ? `${path}/${upload.name}` : upload.name;
            const existing = entries.find(e => e.path === destination);
            if (existing) throw new Error(ui('A file with that name already exists. Rename it before uploading.'));
            const response = await fetch(urlFor(destination), { method: 'POST', headers: { 'X-DSH-Remote-Agents': '1', 'X-File-Size': String(upload.size), 'X-File-Revision': 'new' }, body: upload, signal: abort.current.signal });
            if (!response.ok) throw new Error((await response.json()).error); await reload();
          }); }} /><button disabled={busy} onClick={() => input.current?.click()}>{ui('Upload file')}</button>
        </aside>
        <main><div className="ra-actions"><span className="ra-mono">{selected ?? ui('Choose a file')}</span>{selected && <button disabled={busy} onClick={() => void run(download)}>{ui('Download')}</button>}</div>
          {readOnly && <p className="ra-muted">{readOnly}</p>}
          {file && <textarea className="ra-workspace-editor" aria-label={ui('Remote file contents')} spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} />}
          {info && <><div className="ra-actions">
            {file && <><button className="ra-primary" disabled={busy || !dirty} onClick={() => void run(async () => { const saved = await operate<{ path: string; revision: string; size: number }>({ op: 'write', path: file.path, content: draft, revision: file.revision }); setFile({ ...file, ...saved, content: draft }); setInfo(saved); await reload(); })}>{ui('Save to remote')}</button>
            <button disabled={busy || !dirty} onClick={() => { setDraft(file.content); setError(''); }}>{ui('Discard changes')}</button></>}
            <button disabled={busy} onClick={() => setDeleting(true)}>{ui('Delete file')}</button>
          </div><form className="ra-workspace-rename" onSubmit={event => { event.preventDefault(); const form = event.currentTarget, destination = new FormData(form).get('destination') as string; if (destination.trim()) void run(async () => { await operate({ op: 'move', path: info.path, destination, revision: info.revision }); await reload(); await open(destination); }); }}><input name="destination" aria-label={ui('Rename destination')} placeholder={info.path} /><button disabled={busy || dirty}>{ui('Rename')}</button></form></>}
          {deleting && info && <div className="ra-banner"><span>{ui('Delete this remote file?')}</span><button disabled={busy} onClick={() => void run(async () => { await operate({ op: 'remove', path: info.path, revision: info.revision }); setFile(undefined); setInfo(undefined); setReadOnly(''); setSelected(undefined); setDeleting(false); await reload(); })}>{ui('Delete')}</button><button onClick={() => setDeleting(false)}>{ui('Cancel')}</button></div>}
          {!selected && <p className="ra-muted">{ui('Files are read directly from the remote machine. Saving checks for concurrent edits.')}</p>}
        </main>
      </div>}
      {tab === 'commands' && <div className="ra-workspace-section"><p>{ui('For an interactive terminal, select Remote workspace in the native terminal’s shell menu.')}</p><form onSubmit={event => { event.preventDefault(); void run(async () => {
        const result = await operate<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }>({ op: 'command', path: '.', command });
        setOutput(`${result.stdout}${result.stderr ? '\n' + result.stderr : ''}\n${ui('Exit code')}: ${result.exitCode ?? '—'}${result.timedOut ? '\n' + ui('Command timed out') : ''}${result.truncated ? '\n' + ui('Output truncated') : ''}`);
      }); }}><textarea aria-label={ui('Remote command')} value={command} onChange={e => setCommand(e.target.value)} placeholder="git status" /><button disabled={busy || !command.trim()}>{ui('Run command')}</button></form><pre className="ra-workspace-output">{output}</pre></div>}
      {tab === 'sync' && <div className="ra-workspace-section"><p>{ui('Sync the remote directory and its local workspace mirror. Preview first; files changed on both sides are preserved as conflicts. Git, dependencies and symbolic links are skipped.')}</p><select aria-label={ui('Sync direction')} disabled={busy} value={direction} onChange={e => { setDirection(e.target.value as 'pull' | 'push'); setSync(undefined); }}><option value="pull">{ui('Pull remote → local mirror')}</option><option value="push">{ui('Push local mirror → remote')}</option></select><div className="ra-actions"><button disabled={busy} onClick={() => void run(async () => setSync(await call<SyncResult>('workspaceSync', { direction })))}>{ui('Preview sync')}</button><button disabled={busy || !sync?.dryRun} onClick={() => void run(async () => setSync(await call<SyncResult>('workspaceSync', { direction, apply: true, planId: sync!.planId })))}>{ui('Apply preview')}</button></div>
        {sync && <><p role="status">{ui(sync.dryRun ? 'Sync preview' : 'Sync completed')}: {sync.changes.length} {ui('changes')}, {sync.conflicts.length} {ui('conflicts')}</p><ul>{sync.changes.map(c => <li key={c.path}>{ui(c.action)} · {c.path}</li>)}{sync.conflicts.map(p => <li key={p}>{ui('Conflict')} · {p}</li>)}</ul>{sync.skipped.length > 0 && <details><summary>{ui('Skipped files')} ({sync.skipped.length})</summary><pre>{sync.skipped.join('\n')}</pre></details>}</>}
      </div>}
      {tab === 'tunnels' && <div className="ra-workspace-section"><p>{ui('Forward application ports or a running remote DSH web interface. Tunnels stop when DSH closes; saved definitions remain. Agent sessions keep running independently.')}</p>
        <form className="ra-tunnel-form" onSubmit={event => { event.preventDefault(); void run(async () => { await call('addWorkspaceTunnel', { tunnel: { id: requestId(), direction: tunnelDirection, listenPort: Number(listenPort), targetPort: Number(targetPort), targetHost: '127.0.0.1' } }); setTunnels(await call<Tunnel[]>('workspaceTunnels')); }); }}>
          <label>{ui('Direction')}<select value={tunnelDirection} onChange={e => setTunnelDirection(e.target.value)}><option value="local">{ui('Local → remote')}</option><option value="reverse">{ui('Remote → local')}</option></select></label><label>{ui('Listen port')}<input type="number" min="1" max="65535" required value={listenPort} onChange={e => setListenPort(e.target.value)} /></label><label>{ui('Target port')}<input type="number" min="1" max="65535" required value={targetPort} onChange={e => setTargetPort(e.target.value)} /></label><button disabled={busy}>{ui('Add tunnel')}</button>
        </form><ul className="ra-tunnel-list">{tunnels.map(t => <li key={t.id}><span>{ui(t.direction)} · {t.listenPort} → {t.targetHost}:{t.targetPort} · {ui(t.status)}</span>{t.error && <p role="alert">{t.error}</p>}<div className="ra-actions"><button disabled={busy} onClick={() => void run(() => tunnelAction(t.status === 'running' ? 'stopWorkspaceTunnel' : 'startWorkspaceTunnel', t.id))}>{ui(t.status === 'running' ? 'Stop' : 'Start')}</button>{t.status === 'running' && t.direction === 'local' && <a href={`http://${TUNNEL_ACCESS_HOST}:${t.listenPort}`} target="_blank" rel="noreferrer">{ui('Open')}</a>}<button disabled={busy} onClick={() => void run(() => tunnelAction('removeWorkspaceTunnel', t.id))}>{ui('Remove')}</button></div></li>)}</ul>
      </div>}
      {tab === 'web' && <div className="ra-workspace-section"><p>{ui('Open the remote machine’s DSH interface through SSH. Starting an instance uses an isolated DSH home and requires dsh on the remote login PATH. Closing the tunnel leaves that instance running.')}</p>
        <div className="ra-tunnel-form"><label>{ui('Remote DSH port')}<input aria-label={ui('Remote DSH port')} type="number" min="1024" max="65535" value={webPort} onChange={e => setWebPort(e.target.value)} /></label><button disabled={busy} onClick={() => void run(async () => { const result = await operate<{ url: string }>({ op: 'webStart', path: '.', port: Number(webPort), host: TUNNEL_ACCESS_HOST }); setWebUrl(result.url); setWebLink(''); })}>{ui('Start remote DSH')}</button><button disabled={busy} onClick={() => void run(async () => { await operate({ op: 'webStop', path: '.', port: Number(webPort) }); setWebUrl(''); setWebLink(''); })}>{ui('Stop managed instance')}</button></div>
        <form className="ra-tunnel-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          const remote = new URL(webUrl);
          if (remote.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(remote.hostname) || remote.username || remote.password || !remote.port) throw new Error(ui('Enter the remote loopback DSH login URL.'));
          const listenPort = Number(webLocalPort), targetPort = Number(remote.port);
          // Reconnecting reuses the saved tunnel for this port pair; starting one that already runs returns it unchanged.
          const saved = (await call<Tunnel[]>('workspaceTunnels')).find(t => t.direction === 'local' && t.listenPort === listenPort && t.targetHost === '127.0.0.1' && t.targetPort === targetPort);
          const id = saved?.id ?? requestId();
          if (!saved) await call('addWorkspaceTunnel', { tunnel: { id, direction: 'local', listenPort, targetPort, targetHost: '127.0.0.1' } });
          await call('startWorkspaceTunnel', { id });
          setWebLink(`http://${TUNNEL_ACCESS_HOST}:${Number(webLocalPort)}${remote.pathname}${remote.search}`);
        }); }}><label>{ui('Remote login URL')}<input aria-label={ui('Remote login URL')} type="password" autoComplete="off" value={webUrl} onChange={e => { setWebUrl(e.target.value); setWebLink(''); }} placeholder="http://127.0.0.1:3080/?token=…" /></label><label>{ui('Local DSH port')}<input type="number" min="1" max="65535" value={webLocalPort} onChange={e => setWebLocalPort(e.target.value)} /></label><button disabled={busy || !webUrl}>{ui('Connect remote DSH')}</button></form>
        {webLink && <a href={webLink} target="_blank" rel="noreferrer">{ui('Open remote DSH')}</a>}
      </div>}
      {busy && <p role="status">{ui('Working…')}</p>}
    </>}
  </section>;
}
