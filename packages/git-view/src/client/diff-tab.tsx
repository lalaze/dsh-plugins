import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditor, DiffEditor } from '@dsh-plugins/file-view';
import type { Comparison } from '../domain.js';
import { EDITOR_SRC, git, GitRequestError, requestId } from './api.js';
import { parseConflicts, resolveConflict, linesOf, type ConflictBlock } from './conflicts.js';
import { i18n, localizeError, ui, useLocale } from './i18n.js';
import { Icon, type IconName } from './icons.js';
import { cwdOf, useCwd } from './sessions.js';
import { STATUS_COLORS, statusLetter, type StatusCache } from './status.js';
import { announceChange } from './store.js';
import { styles } from './styles.js';

export interface FileAddress { sessionId: string; path: string }
/** DSH's `dsh-resource://file/session/<id>/<path>` address of a conversation's file. */
export function fileAddress(address: string): FileAddress | undefined {
  try {
    const url = new URL(address), [scope, id, ...parts] = url.pathname.replace(/^\//, '').split('/');
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file' || scope !== 'session' || !id || !parts.length) return;
    const path = parts.map(decodeURIComponent).join('/');
    return path ? { sessionId: decodeURIComponent(id), path } : undefined;
  } catch { return; }
}
/** Encoded segment by segment as DSH builds it (`:` stays literal for drive letters). */
export function sessionFileAddress(sessionId: string, path: string): string {
  const encode = (segment: string) => encodeURIComponent(segment).replace(/%3A/gi, ':');
  return `dsh-resource://file/session/${encode(sessionId)}/${path.split('/').map(encode).join('/')}`;
}

type Mode = 'split' | 'inline' | 'edit' | 'conflict';
const lineCount = (text: string) => text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
/** Lines shown above and below a conflict; farther lines fold. */
const CONTEXT = 8;
interface Tools { openResource?(address: string, options?: Record<string, unknown>): void }

/**
 * The conflict blocks with the code around them first: each block's current and incoming sides, side by side, with
 * accept-current, accept-incoming and accept-both; unconflicted code farther than eight lines folds, keeping its numbers.
 */
function ConflictView({ text, onResolve }: { text: string; onResolve(block: ConflictBlock, choice: 'ours' | 'theirs' | 'both'): void }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const blocks = useMemo(() => parseConflicts(text), [text]), lines = useMemo(() => linesOf(text).map(line => line.replace(/\r?\n$/, '')), [text]);
  if (!blocks.length) return <div className="gv-resolved" role="status"><Icon name="check" size={14} />{ui('Every conflict block is resolved. Save and resolve writes and stages this file.')}</div>;
  const source = (from: number, to: number) => <div className="gv-source">{lines.slice(from, to).map((line, i) => <div key={from + i}><span>{from + i + 1}</span><span>{line || ' '}</span></div>)}</div>;
  const fold = (from: number, to: number, key: number) => to <= from ? null : open.has(key) ? <React.Fragment key={`f${key}`}>{source(from, to)}</React.Fragment>
    : <button type="button" key={`f${key}`} className="gv-gap" onClick={() => setOpen(new Set([...open, key]))}><Icon name="fold" size={12} /> {ui('Show lines {from}–{to} ({count} unchanged)', { from: from + 1, to, count: to - from })}</button>;
  const parts: React.ReactNode[] = [<div key="hint" className="gv-hint"><Icon name="bulb" size={14} />{ui('Each conflict is shown with the code around it. Choose a side for every block, then Save and resolve.')}</div>];
  let at = 0;
  blocks.forEach((block, index) => {
    const from = Math.max(at, block.start - CONTEXT);
    parts.push(fold(at, from, index), <React.Fragment key={`b${index}`}>{source(from, block.start)}</React.Fragment>);
    parts.push(<div key={`c${block.start}`} className="gv-block">
      <div className="gv-block-head">
        <b><Icon name="conflict" size={14} />{ui('Conflict {index} of {total} · lines {from}–{to}', { index: index + 1, total: blocks.length, from: block.start + 1, to: block.end + 1 })}</b>
        <button type="button" className="gv-btn" onClick={() => onResolve(block, 'ours')}><Icon name="check" size={13} />{ui('Accept current (HEAD)')}</button>
        <button type="button" className="gv-btn" onClick={() => onResolve(block, 'theirs')}><Icon name="check" size={13} />{ui('Accept incoming ({label})', { label: block.label })}</button>
        <button type="button" className="gv-btn" onClick={() => onResolve(block, 'both')}><Icon name="both" size={13} />{ui('Accept both')}</button>
      </div>
      <div className="gv-sides">
        <div><small>{ui('Current (HEAD)')}</small><pre>{block.ours.replace(/\r?\n$/, '') || ui('(empty)')}</pre></div>
        <div><small>{ui('Incoming ({label})', { label: block.label })}</small><pre>{block.theirs.replace(/\r?\n$/, '') || ui('(empty)')}</pre></div>
      </div>
    </div>);
    at = Math.min(lines.length, block.end + 1 + CONTEXT);
    parts.push(<React.Fragment key={`a${index}`}>{source(block.end + 1, at)}</React.Fragment>);
  });
  parts.push(fold(at, lines.length, blocks.length));
  return <div className="gv-conflicts">{parts}</div>;
}

const ToolButton = ({ label, icon, pressed, ...props }: { label: string; icon: IconName; pressed?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" className="gv-tool" title={label} aria-label={label} aria-pressed={pressed} {...props}><Icon name={icon} size={14} /></button>;

/**
 * A changed file beside its HEAD version, in VS Code's diff editor: two columns or one, word wrap, folded unchanged
 * regions and font size; an edit mode; and merge-conflict resolution. Saves check the file revision and workspace.
 */
interface DiffTabProps {
  address: string; cache: StatusCache; tools?: Tools; viewers?(address: string): string | undefined;
  /** The sidebar's navigation count: opening the file again reloads it. */
  revision?: number;
}
export function DiffTab(props: DiffTabProps) {
  const cwd = useCwd(fileAddress(props.address)?.sessionId);
  return <WorkspaceDiff key={props.address} {...props} cwd={cwd} />;
}
/** Keep an old draft visible but inert after retargeting a conversation; only an explicit reload discards it. */
function WorkspaceDiff({ cwd, ...props }: DiffTabProps & { cwd?: string }) {
  useLocale();
  const [bound, setBound] = useState(cwd);
  useEffect(() => { if (!bound && cwd) setBound(cwd); }, [bound, cwd]);
  if (!bound) return <p role="status">{ui('Open a conversation in a project folder to see its Git repository')}</p>;
  return <BoundDiffTab key={bound} {...props} expectedCwd={bound} workspaceChanged={cwd !== bound} rebind={() => { if (cwd) setBound(cwd); }} />;
}
function BoundDiffTab({ address, cache, tools, viewers, revision = 0, expectedCwd, workspaceChanged, rebind }: DiffTabProps & {
  expectedCwd: string; workspaceChanged: boolean; rebind(): void;
}) {
  useLocale();
  const parsed = useMemo(() => fileAddress(address), [address]), sessionId = parsed?.sessionId ?? '', path = parsed?.path ?? '';
  const [file, setFile] = useState<Comparison>(), [draft, setDraft] = useState(''), [error, setError] = useState(''), [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' }>();
  const [mode, setMode] = useState<Mode>('split'), [wrap, setWrap] = useState(true), [collapse, setCollapse] = useState(true), [fontSize, setFontSize] = useState(12);
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [stats, setStats] = useState({ added: 0, removed: 0 });
  const alive = useRef(true), edits = useRef(0), loads = useRef(0), acting = useRef(false);
  const editDraft = (text: string) => { edits.current++; setDraft(text); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const working = file?.working.kind === 'text' ? file.working : undefined, dirty = !!working && draft !== working.content;
  const conflicts = useMemo(() => parseConflicts(draft).length, [draft]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const turn = ++loads.current, version = edits.current;
    const value = await git<Comparison>('compare', { sessionId, path, expectedCwd }, signal);
    if (!alive.current || signal?.aborted || turn !== loads.current || cwdOf(sessionId) !== expectedCwd) return;
    // A refresh may have started while clean; typing during SSH latency must not lose that new draft.
    if (version !== edits.current) { setStale(true); return; }
    const text = value.working.kind === 'text' ? value.working.content : '';
    setFile(value); setDraft(text); setError(''); setStale(false);
    // A conflicted file opens on its conflicts.
    if (parseConflicts(text).length) setMode('conflict');
  }, [sessionId, path, expectedCwd]);
  useEffect(() => {
    if (!parsed) return;
    const c = new AbortController();
    void load(c.signal).catch(e => { if (!c.signal.aborted) setError(localizeError(e)); });
    return () => c.abort();
  }, [load, parsed]);
  // Opening the file again, or Git reporting it differently (after a merge or an agent's edit), reloads it, unless
  // that would discard unsaved edits.
  const latest = useRef({ dirty, busy, file });
  latest.current = { dirty, busy, file };
  const refresh = useCallback(() => {
    const now = latest.current;
    if (!now.file || now.busy || cwdOf(sessionId) !== expectedCwd) return;
    if (now.dirty) setStale(true); else void load().catch(e => { if (alive.current) setError(localizeError(e)); });
  }, [load, sessionId, expectedCwd]);
  const seenRevision = useRef(revision);
  useEffect(() => { if (revision !== seenRevision.current) { seenRevision.current = revision; refresh(); } }, [revision, refresh]);
  useEffect(() => {
    let seen = cache.codeOf(expectedCwd, path);
    return cache.subscribe(() => { const code = cache.codeOf(expectedCwd, path); if (code !== seen) { seen = code; refresh(); } });
  }, [cache, expectedCwd, path, refresh]);
  const act = async (action: () => Promise<void>) => {
    if (acting.current) return;
    if (cwdOf(sessionId) !== expectedCwd) { setNote({ text: ui('The workspace changed. Reopen the file before continuing.'), tone: 'error' }); return; }
    ++loads.current; // A pending background refresh must not replace the result of this action.
    acting.current = true; setBusy(true); setNote(undefined);
    try { await action(); } catch (e) { if (alive.current) setNote({ text: localizeError(e), tone: 'error' }); } finally { acting.current = false; if (alive.current) setBusy(false); }
  };
  const refreshed = () => { announceChange(expectedCwd); void cache.ensure(expectedCwd, true); };
  const remainingMarkers = /^(?:<{7}|={7}|>{7}|\|{7})/m.test(draft);
  const conflictFile = !!file?.code && ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.code);
  const saveFile = (resolve: boolean) => {
    if (!working || (!dirty && !resolve) || (resolve && remainingMarkers)) return;
    // Capture the submitted text. A late response must update this baseline, never replace newer edits.
    const submitted = draft, version = edits.current;
    void act(async () => {
      try {
        const saved = await git<{ revision: string; staged?: boolean; error?: string }>(resolve ? 'saveResolve' : 'save',
          { sessionId, path, content: submitted, revision: working.revision, expectedCwd, ...(resolve ? { requestId: requestId() } : {}) });
        if (!alive.current) return;
        setFile(current => current && { ...current, ...(saved.staged ? { code: undefined } : {}),
          working: { kind: 'text', content: submitted, revision: saved.revision, size: new TextEncoder().encode(submitted).length } });
        setStale(false);
        setNote(resolve && !saved.staged
          ? { text: ui('Saved, but not staged: {error}', { error: localizeError(saved.error || 'git add failed') }), tone: 'error' }
          : { text: resolve ? ui('Saved and staged. Complete the merge or rebase when all conflicts are resolved.') : ui('Saved to the workspace'), tone: 'ok' });
        if (saved.staged && version === edits.current) setMode('split');
        refreshed();
      } catch (e) { if ((e as GitRequestError).status === 409) setStale(true); throw e; }
    });
  };
  const save = () => saveFile(false);
  const saveAndResolve = () => saveFile(true);
  const stage = () => void act(async () => {
    await git('stage', { sessionId, path: file!.repoPath, requestId: requestId(), expectedCwd });
    if (alive.current) setNote({ text: ui('Staged'), tone: 'ok' });
    refreshed();
  });
  const viewer = viewers?.(address);
  if (!parsed) return null;
  const name = path.split('/').pop() ?? path, letter = file?.code ? statusLetter(file.code) : undefined;
  const headText = file?.head.kind === 'text' ? file.head.content : '';
  const comparable = !!file && file.head.kind !== 'binary' && file.head.kind !== 'large' && (file.working.kind === 'text' || file.working.kind === 'missing');
  // Monaco compares a new or deleted file with an empty document, which still has one line; count whole files instead.
  const shown = file?.head.kind === 'absent' ? { added: lineCount(draft), removed: 0 } : file?.working.kind === 'missing' ? { added: 0, removed: lineCount(headText) } : stats;
  return <section className="gv-diff" aria-label={ui('Changes in {file}', { file: name })}><style>{styles}</style>
    <header className="gv-diff-head">
      <div className="gv-diff-id">
        <Icon name="file" size={14} /><span className="gv-diff-name">{name}</span>
        {letter && <span className="gv-letter" style={{ color: STATUS_COLORS[letter] }} title={ui('Git status: {status}', { status: file!.code! })}>{letter}</span>}
        {file?.head.kind === 'absent' && <span className="gv-tag" title={ui('Not in HEAD')}>{ui('New')}</span>}
        <span className="gv-diff-path" title={path}><bdi>{path}</bdi></span>
        {comparable && mode !== 'conflict' && <span className="gv-stat"><b title={shown.added === 1 ? ui('One line added') : ui('{count} lines added', { count: shown.added })}>+{shown.added}</b><i title={shown.removed === 1 ? ui('One line removed') : ui('{count} lines removed', { count: shown.removed })}>−{shown.removed}</i></span>}
      </div>
      <div className="gv-diff-tools">
        <ToolButton label={ui('Side by side')} icon="split" pressed={mode === 'split'} onClick={() => setMode('split')} />
        <ToolButton label={ui('Inline')} icon="unified" pressed={mode === 'inline'} onClick={() => setMode('inline')} />
        <ToolButton label={ui('Edit the file')} icon="edit" pressed={mode === 'edit'} disabled={!working} onClick={() => setMode('edit')} />
        {conflicts > 0 && <ToolButton label={ui('Resolve merge conflicts ({count})', { count: conflicts })} icon="conflict" data-tone="warn" pressed={mode === 'conflict'} onClick={() => setMode('conflict')} />}
        <span className="gv-sep" aria-hidden="true" />
        <ToolButton label={ui('Word wrap')} icon="wrap" pressed={wrap} onClick={() => setWrap(!wrap)} />
        <ToolButton label={ui('Fold unchanged regions')} icon="fold" pressed={collapse} onClick={() => setCollapse(!collapse)} />
        <ToolButton label={ui('Smaller font')} icon="minus" disabled={fontSize <= 9} onClick={() => setFontSize(fontSize - 1)} />
        <span className="gv-size" title={ui('Font size {size}px', { size: fontSize })}>{fontSize}</span>
        <ToolButton label={ui('Larger font')} icon="plus" disabled={fontSize >= 24} onClick={() => setFontSize(fontSize + 1)} />
        <span className="gv-sep" aria-hidden="true" />
        {viewer && <ToolButton label={ui('Open the file')} icon="code" onClick={() => tools?.openResource?.(address, { kind: viewer })} />}
        <ToolButton label={ui('Stage this file')} icon="plus" disabled={busy || !file || workspaceChanged} onClick={stage} />
        <ToolButton label={ui('Reload')} icon="refresh" disabled={busy || (!workspaceChanged && dirty && !stale)} onClick={() => workspaceChanged ? rebind() : void act(() => load())} />
        {conflictFile && <button type="button" className="gv-btn" disabled={busy || !working || remainingMarkers || workspaceChanged} onClick={saveAndResolve}>{ui('Save and resolve')}</button>}
        <ToolButton label={dirty ? `${ui('Save')} (⌘/Ctrl+S)` : ui('Saved')} icon={dirty ? 'save' : 'check'} disabled={busy || !dirty || workspaceChanged} onClick={save} />
      </div>
    </header>
    {(error || note || stale || workspaceChanged || (file && file.working.kind !== 'text') || file?.head.kind === 'binary' || file?.head.kind === 'large' || file?.head.kind === 'absent') && <div className="gv-notes">
      {workspaceChanged && <span className="gv-note" data-tone="error" role="alert">{ui('The workspace changed. Reopen the file before continuing.')} {ui('Reload to see the new version; your unsaved changes will be lost.')}</span>}
      {error && <span className="gv-note" data-tone="error" role="alert">{error}</span>}
      {stale && <span className="gv-note" data-tone="error">{ui('The file changed on disk.')} {ui('Reload to see the new version; your unsaved changes will be lost.')}</span>}
      {file?.working.kind === 'missing' && <span className="gv-note">{ui('The file was deleted from the workspace')}</span>}
      {(file?.working.kind === 'binary' || file?.head.kind === 'binary') && <span className="gv-note">{ui('Binary file: no text comparison')}</span>}
      {(file?.working.kind === 'large' || file?.head.kind === 'large') && <span className="gv-note">{ui('The file is larger than the 4 MB comparison limit')}</span>}
      {file?.head.kind === 'absent' && file.working.kind === 'text' && <span className="gv-note">{ui('A new file: every line is added')}</span>}
      {note && <span className="gv-note" data-tone={note.tone} role={note.tone === 'error' ? 'alert' : 'status'}>{note.text}</span>}
    </div>}
    <div className="gv-diff-body">
      {!file ? !error && <p className="gv-empty" role="status">{ui('Reading the file from Git…')}</p>
        : !comparable ? null
        : mode === 'conflict' && working ? <ConflictView text={draft} onResolve={(block, choice) => {
          if (workspaceChanged) return;
          editDraft(resolveConflict(draft, block, choice));
          setNote({ text: choice === 'ours' ? ui('Kept the current change') : choice === 'theirs' ? ui('Took the incoming change') : ui('Kept both changes'), tone: 'ok' });
        }} />
        : mode === 'edit' && working ? <CodeEditor key="edit" label={ui('File contents')} src={EDITOR_SRC} locale={i18n.activeLocale()} path={path} value={draft} onChange={editDraft} onSave={save} readOnly={busy || workspaceChanged} />
        : <DiffEditor key="diff" label={ui('Working tree version of {file}', { file: name })} src={EDITOR_SRC} locale={i18n.activeLocale()} path={path} original={headText} modified={draft}
          onChange={editDraft} onSave={save} onStats={setStats} sideBySide={mode !== 'inline'} wrap={wrap} collapseUnchanged={collapse} fontSize={fontSize} readOnly={busy || !working || workspaceChanged} />}
    </div>
  </section>;
}
