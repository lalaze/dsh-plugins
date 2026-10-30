import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Branch, Change, CredentialTarget, Done, Location, Overview } from '../domain.js';
import { git, GitRequestError, requestId } from './api.js';
import { sendToComposer } from './composer.js';
import { Graph } from './graph.js';
import { localizeError, ui, useLocale } from './i18n.js';
import { Icon, type IconName } from './icons.js';
import { announceChange, onChange, updateFolder, useFolderState, type Notice } from './store.js';
import type { StatusCache } from './status.js';

/** What each change is called while it runs and in its result. */
const LABELS: Record<string, string> = {
  pull: 'Pull', push: 'Push', sync: 'Sync', fetch: 'Fetch all', commit: 'Commit', switch: 'Switch branch', checkout: 'Check out', rename: 'Rename',
  deleteBranch: 'Delete branch', deleteRemoteBranch: 'Delete remote branch', merge: 'Merge', stashPush: 'Stash', stashPop: 'Pop stash', stage: 'Stage',
  unstage: 'Unstage', discard: 'Discard changes', cherryPick: 'Cherry-pick', revert: 'Revert',
};
const CONFLICTS = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
interface Pending { action: string; data: Record<string, unknown> }
interface Menu { x: number; y: number; branch: Branch; remote: boolean; mode: 'main' | 'rename' | 'delete' }

/** An icon button at the end of a change row; its label shows at once on hover, unlike a native tooltip. */
function RowAction({ icon, label, danger, onClick }: { icon: IconName; label: string; danger?: boolean; onClick(): void }) {
  return <button type="button" className="gv-act" aria-label={label} data-tone={danger ? 'danger' : undefined}
    onMouseEnter={e => showTip(e.currentTarget, label)} onMouseLeave={hideTip} onFocus={e => showTip(e.currentTarget, label)} onBlur={hideTip}
    onClick={event => { event.stopPropagation(); hideTip(); onClick(); }}><Icon name={icon} size={13} /></button>;
}
let tip: HTMLDivElement | undefined;
function showTip(anchor: HTMLElement, text: string) {
  tip ??= Object.assign(document.createElement('div'), { className: 'gv-tip', role: 'tooltip' });
  tip.textContent = text;
  if (!tip.isConnected) document.body.append(tip);
  const rect = anchor.getBoundingClientRect(), width = tip.offsetWidth;
  tip.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, rect.left + rect.width / 2 - width / 2))}px`;
  tip.style.top = `${rect.top - tip.offsetHeight - 6 < 4 ? rect.bottom + 6 : rect.top - tip.offsetHeight - 6}px`;
}
const hideTip = () => { tip?.remove(); };

/** Two-line branch rows as in GitLens: double-click switches, or pulls the current branch; right-click opens its actions. */
const BranchRow = memo(function BranchRow({ branch, remote, busy, pulling, onActivate, onPull, onMenu }: {
  branch: Branch; remote: boolean; busy: boolean; pulling: boolean; onActivate(branch: Branch, remote: boolean): void; onPull(): void;
  onMenu(event: { clientX: number; clientY: number }, branch: Branch, remote: boolean): void;
}) {
  const date = branch.date.slice(5, 16);
  return <div className="gv-branch" tabIndex={0} title={`${branch.name}\n${branch.subject}${date ? ` (${date})` : ''}`}
    onDoubleClick={() => { if (!busy) onActivate(branch, remote); }}
    onKeyDown={event => {
      if (event.key === 'Enter' && !busy) onActivate(branch, remote);
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(); onMenu({ clientX: r.left + 16, clientY: r.bottom }, branch, remote); }
    }}
    onContextMenu={event => { event.preventDefault(); onMenu(event, branch, remote); }}>
    <div className="gv-branch-top">
      <span className="gv-branch-name">{branch.name}</span>
      {!!branch.ahead && <span className="gv-badge" data-kind="ahead" title={branch.ahead === 1 ? ui('One commit to push') : ui('{count} commits to push', { count: branch.ahead })}><Icon name="arrowUp" size={11} />{branch.ahead}</span>}
      {!!branch.behind && (branch.current
        ? <button type="button" className="gv-badge" data-kind="behind" disabled={busy} title={pulling ? ui('Pulling…') : branch.behind === 1 ? ui('One commit behind upstream; click to pull') : ui('{count} commits behind upstream; click to pull', { count: branch.behind })} onClick={event => { event.stopPropagation(); onPull(); }}>
          {pulling ? <span className="gv-spinner" /> : <Icon name="arrowDown" size={11} />}{pulling ? ui('Pulling…') : branch.behind}</button>
        : <span className="gv-badge" data-kind="behind"><Icon name="arrowDown" size={11} />{branch.behind}</span>)}
      {branch.gone && <span className="gv-badge" title={ui('The upstream branch was deleted')}>{ui('gone')}</span>}
      {branch.current && <span className="gv-badge" data-kind="current">{ui('current')}</span>}
    </div>
    {(branch.subject || date) && <div className="gv-branch-bottom"><span>{branch.subject || '—'}</span>{date && <span>{date}</span>}</div>}
  </div>;
});

/** `git diff` lines numbered by the file they come from: removed lines by the old file, the others by the new one. */
function DiffLines({ text }: { text: string }) {
  let before = 0, after = 0;
  return <div className="gv-lines">{text.slice(0, 30_000).split('\n').map((line, index) => {
    let kind = '', number = '';
    if (line.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) { before = Number(match[1]); after = Number(match[2]); }
      kind = 'hunk';
    } else if (line.startsWith('+') && !line.startsWith('+++')) { kind = 'add'; number = String(after++); }
    else if (line.startsWith('-') && !line.startsWith('---')) { kind = 'del'; number = String(before++); }
    else if (line.startsWith(' ')) { number = String(after++); before++; }
    return <div key={index} className="gv-line" data-kind={kind || undefined}><span>{number}</span><span>{line || ' '}</span></div>;
  })}</div>;
}

/** Sign-in help after a failed network operation: a credential form for HTTPS remotes of this machine, else advice. */
function SignIn({ sessionId, auth, location, onSaved, onClose }: { sessionId: string; auth: 'https' | 'ssh'; location: Location; onSaved(): void; onClose(): void }) {
  const [target, setTarget] = useState<CredentialTarget>(), [host, setHost] = useState(''), [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const local = location.kind === 'local';
  useEffect(() => {
    if (auth !== 'https' || !local) return;
    const c = new AbortController();
    git<CredentialTarget>('credentialTarget', { sessionId }, c.signal).then(value => { if (!c.signal.aborted) { setTarget(value); setHost(value.host ?? ''); setUsername(value.username ?? ''); } }, () => setTarget({}));
    return () => c.abort();
  }, [auth, local, sessionId]);
  const machine = location.kind === 'remote' ? location.host : ui('this machine');
  if (auth === 'ssh') return <div className="gv-auth"><b><Icon name="key" size={13} />{ui('SSH sign-in failed')}</b>
    <p>{ui('Git on {machine} has no SSH key this Git server accepts. Add one on {machine}, for example in ~/.ssh, then try again.', { machine })}</p></div>;
  if (!local) return <div className="gv-auth"><b><Icon name="key" size={13} />{ui('Sign-in failed')}</b>
    <p>{ui('Git on {machine} could not sign in to the Git server. Credentials are not saved for remote workspaces: set up a credential helper or an SSH remote on {machine}, then try again.', { machine })}</p></div>;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!host.trim() || !username.trim() || !password) { setError(ui('Enter the host, a username and a password or token')); return; }
    setBusy(true); setError('');
    try { await git('saveCredential', { sessionId, host: host.trim(), username: username.trim(), password }); setPassword(''); onSaved(); }
    catch (e) { setError(localizeError(e)); }
    finally { setBusy(false); }
  };
  return <form className="gv-auth" onSubmit={save}>
    <b><Icon name="key" size={13} />{ui('Sign in to the Git server')}</b>
    <p>{ui('Saved for this Git view only, for HTTPS remotes of this host; Git in a terminal is unchanged.')}</p>
    {target && !target.host && <p>{ui('This repository’s remote does not use HTTPS. Enter the host of an HTTPS remote, or set up an SSH key instead.')}</p>}
    <input className="gv-input" aria-label={ui('Host')} placeholder={ui('Host, such as github.com')} value={host} onChange={e => setHost(e.target.value)} />
    <input className="gv-input" aria-label={ui('Username')} placeholder={ui('Username')} autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} />
    <input className="gv-input" type="password" aria-label={ui('Password or access token')} placeholder={ui('Password or access token')} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
    {error && <p role="alert">{error}</p>}
    <div className="gv-row" style={{ justifyContent: 'flex-end' }}>
      <button type="submit" className="gv-btn" disabled={busy}><Icon name="save" size={13} />{ui('Save and retry')}</button>
      <button type="button" className="gv-btn" onClick={onClose}>{ui('Cancel')}</button>
    </div>
  </form>;
}

/**
 * The Git view of a conversation's workspace, on this machine or on its remote machine: branches and the commit graph;
 * commit, push, sync and stash; the change list with stage, unstage, discard and diffs; and "send to chat" prompts.
 */
export function GitPanel({ sessionId, cwd, cache, openDiff }: { sessionId: string; cwd: string; cache: StatusCache; openDiff?(path: string): boolean }) {
  useLocale();
  const { operation, notice } = useFolderState(cwd), busy = !!operation;
  const [view, setView] = useState<Overview>(), [loading, setLoading] = useState(false), [failure, setFailure] = useState('');
  const [tab, setTab] = useState<'branches' | 'graph'>('branches'), [message, setMessage] = useState(''), [search, setSearch] = useState('');
  const [menu, setMenu] = useState<Menu>(), [renameTo, setRenameTo] = useState('');
  const [inline, setInline] = useState<{ path: string; staged: boolean; text?: string }>(), [width, setWidth] = useState(300);
  const root = useRef<HTMLDivElement>(null), sequence = useRef(0), failed = useRef<Pending>(), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; hideTip(); }; }, []);
  const load = useCallback(async (quiet = false) => {
    const turn = ++sequence.current;
    if (!quiet) setLoading(true);
    try {
      const value = await git<Overview>('overview', { sessionId });
      if (turn !== sequence.current || !alive.current) return;
      setView(value); setFailure(''); cache.set(cwd, value);
    } catch (e) {
      if (turn !== sequence.current || !alive.current) return;
      setFailure(localizeError(e));
      if ((e as GitRequestError).code === 'not-a-repo') setView(undefined);
    } finally { if (turn === sequence.current && alive.current) setLoading(false); }
  }, [sessionId, cwd, cache]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onChange(changed => { if (changed === cwd) void load(true); }), [cwd, load]);
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setWidth(Math.max(240, element.clientWidth - 16)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Runs one change; its progress and result stay with the folder, and its ID lets Cancel stop it. */
  const run = useCallback(async (kind: string, action: string, data: Record<string, unknown> = {}) => {
    if (operation) return;
    const id = requestId(), label = ui(LABELS[kind] ?? kind);
    failed.current = undefined;
    updateFolder(cwd, { operation: { kind, requestId: id }, notice: { tone: 'progress', text: ui('Running {label}…', { label }) } });
    let result: Notice;
    try {
      const done = await git<Done>(action, { sessionId, requestId: id, ...data });
      result = { tone: 'ok', text: done.output || ui('{label} done', { label }) };
      if (kind === 'commit') setMessage('');
    } catch (e) {
      const auth = e instanceof GitRequestError ? e.auth : undefined;
      if (auth) failed.current = { action, data: { ...data, kind } };
      result = { tone: 'error', text: localizeError(e), ...auth ? { auth } : {} };
    }
    updateFolder(cwd, { operation: undefined, notice: result });
    announceChange(cwd);
    void cache.ensure(cwd, true);
  }, [operation, cwd, sessionId, cache]);
  const cancel = () => {
    if (!operation) return;
    updateFolder(cwd, { notice: { tone: 'progress', text: ui('Cancelling…') } });
    void git('cancel', { requestId: operation.requestId }).catch(() => {});
  };
  const retry = () => {
    const pending = failed.current;
    if (!pending) { updateFolder(cwd, { notice: undefined }); return; }
    const { kind, ...data } = pending.data;
    void run(String(kind), pending.action, data);
  };
  const ask = (text: string) => {
    updateFolder(cwd, { notice: sendToComposer(sessionId, text) ? { tone: 'ok', text: ui('Added to the message box') } : { tone: 'error', text: ui('Open the conversation’s message box first') } });
  };
  const copy = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text).then(() => updateFolder(cwd, { notice: { tone: 'ok', text: done } }), () => {});
  };
  const showDiff = async (path: string, staged = false) => {
    setInline({ path, staged });
    try { const { output } = await git<Done>('diff', { sessionId, path, staged }); if (alive.current) setInline(current => current?.path === path && current.staged === staged ? { path, staged, text: output } : current); }
    catch (e) { if (alive.current) setInline(current => current?.path === path && current.staged === staged ? { path, staged, text: localizeError(e) } : current); }
  };
  const activate = useCallback((branch: Branch, remote: boolean) => {
    if (remote) void run('checkout', 'switch', { branch: branch.name, remote: true });
    else if (branch.current) void run('pull', 'pull');
    else void run('switch', 'switch', { branch: branch.name });
  }, [run]);
  const pull = useCallback(() => { void run('pull', 'pull'); }, [run]);
  const openMenu = useCallback((event: { clientX: number; clientY: number }, branch: Branch, remote: boolean) => {
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 200), y: Math.min(event.clientY, window.innerHeight - 220), branch, remote, mode: 'main' });
    setRenameTo(branch.name);
  }, []);

  const changes = view?.changes ?? [], location = view?.location ?? { kind: 'local' as const };
  const conflicts = changes.filter(c => CONFLICTS.includes(c.code));
  const staged = changes.filter(c => !CONFLICTS.includes(c.code) && c.code[0] !== ' ' && c.code[0] !== '?');
  const unstaged = changes.filter(c => !CONFLICTS.includes(c.code) && (c.code[1] !== ' ' || c.code === '??'));
  const query = search.trim().toLowerCase(), matches = (b: Branch) => !query || b.name.toLowerCase().includes(query) || b.subject.toLowerCase().includes(query);
  const pending = operation?.kind, spin = (kind: string, text: string) => pending === kind ? <><span className="gv-spinner" />{text}</> : null;
  const sendChanges = () => ask(conflicts.length
    ? ui('Git found merge conflicts in these files:\n{files}\n\nOther changed files: {others}. Explain why each conflict happened and how to resolve it safely, keeping the current or the incoming change.',
      { files: conflicts.map(c => `- \`${c.path}\` (CONFLICT)`).join('\n'), others: changes.length - conflicts.length })
    : ui('The workspace has these Git changes:\n{files}\n\nReview them and write a clear commit message following common conventions.',
      { files: changes.map(c => `- \`${c.code}\` ${c.path}`).join('\n') }));
  const row = (change: Change, group: 'conflict' | 'staged' | 'unstaged') => {
    const full = () => !!change.local && !!openDiff?.(change.local);
    return <div key={`${group}:${change.path}`} className="gv-change" role="button" tabIndex={0}
      title={group === 'staged' ? ui('Show the diff') : ui('Open the diff beside the conversation')}
      onClick={() => { if (group === 'staged' || !full()) void showDiff(change.path, group === 'staged'); }}
      onKeyDown={event => { if (event.key === 'Enter' && event.currentTarget === event.target) { if (group === 'staged' || !full()) void showDiff(change.path, group === 'staged'); } }}>
      <span className="gv-code" data-conflict={group === 'conflict' ? '' : undefined}>{change.code}</span>
      <span className="gv-path" title={change.from ? `${change.from} → ${change.path}` : change.path}><bdi>{change.path}</bdi></span>
      {group !== 'staged' && <RowAction icon="unified" label={ui('Show the diff here')} onClick={() => void showDiff(change.path)} />}
      <RowAction icon="copy" label={ui('Copy the path')} onClick={() => copy(change.path, ui('Path copied'))} />
      <RowAction icon="chat" label={ui('Ask the agent about this file')}
        onClick={() => ask(group === 'staged' ? ui('Please review the staged file `{file}`.', { file: change.path }) : ui('Please review and handle the changes in `{file}`.', { file: change.path }))} />
      {group === 'staged' && <RowAction icon="minus" label={ui('Unstage')} onClick={() => void run('unstage', 'unstage', { path: change.path, ...(change.from ? { from: change.from } : {}) })} />}
      {group !== 'staged' && <RowAction icon="plus" label={ui('Stage')} onClick={() => void run('stage', 'stage', { path: change.path })} />}
      {group === 'unstaged' && <RowAction icon="undo" danger label={ui('Discard changes')} onClick={() => {
        if (window.confirm(ui('Discard the changes in {file}? This cannot be undone.', { file: change.path }))) void run('discard', 'discard', { path: change.path, untracked: change.code === '??' });
      }} />}
    </div>;
  };
  const group = (title: string, list: Change[], kind: 'conflict' | 'staged' | 'unstaged') => list.length > 0 && <div>
    <div className="gv-group-head" data-tone={kind === 'conflict' ? 'danger' : undefined}>{title} ({list.length})</div>
    <div className="gv-list">{list.map(change => row(change, kind))}</div>
  </div>;

  return <div className="gv" ref={root}>
    <div className="gv-head">
      <span>Git</span><span className="gv-repo">{view?.repo}</span>
      {location.kind === 'remote' && <span className="gv-host" title={ui('Git runs on {host} in {cwd}', { host: location.host, cwd: location.cwd })}><Icon name="server" size={11} />{location.host}</span>}
      <span className="gv-spacer" />
      <button type="button" className="gv-tool" title={ui('Refresh')} aria-label={ui('Refresh')} disabled={loading || busy} onClick={() => void load()}>
        {loading || busy ? <span className="gv-spinner" role="status" aria-label={ui('Loading…')} /> : <Icon name="refresh" size={13} />}</button>
    </div>
    {busy && <div className="gv-progress" role="progressbar" aria-label={ui('Running {label}…', { label: ui(LABELS[pending!] ?? '') })} />}
    {view && <>
      <div className="gv-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'branches'} onClick={() => setTab('branches')}>{ui('Branches')}</button>
        <button type="button" role="tab" aria-selected={tab === 'graph'} onClick={() => setTab('graph')}>{ui('Graph')}</button>
      </div>
      <div className="gv-write">
        <div className="gv-row">
          <input className="gv-input" aria-label={ui('Commit message')} placeholder={ui('Commit message; Enter commits all changes')} value={message}
            onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && message.trim() && !busy) void run('commit', 'commit', { message }); }} />
          <button type="button" className="gv-btn" disabled={busy || !message.trim()} onClick={() => void run('commit', 'commit', { message })}>{spin('commit', ui('Committing…')) ?? ui('Commit')}</button>
          <button type="button" className="gv-btn" disabled={busy} onClick={() => void run('push', 'push')}>{spin('push', ui('Pushing…')) ?? ui('Push')}</button>
          <button type="button" className="gv-btn" disabled={busy} title={ui('Fetch, merge upstream changes without rebasing, then push')} onClick={() => void run('sync', 'sync')}>{spin('sync', ui('Syncing…')) ?? ui('Sync')}</button>
        </div>
        <div className="gv-row">
          <button type="button" className="gv-btn" disabled={busy} onClick={() => void run('stashPush', 'stashPush')}>{ui('Stash')}</button>
          <button type="button" className="gv-btn" disabled={busy} onClick={() => void run('stashPop', 'stashPop')}>{ui('Pop stash')}</button>
          <button type="button" className="gv-btn" disabled={busy || loading} onClick={() => void load(true)}>{ui('Status')}</button>
          <span className="gv-status-line">{changes.length > 1 ? ui('{count} changed files', { count: changes.length }) : changes.length ? ui('One changed file') : ui('No changes')}</span>
        </div>
        {changes.length > 0 && <div className="gv-changes">
          <div className="gv-changes-head"><span>{ui('Changes')} ({changes.length})</span>
            <button type="button" className="gv-btn" onClick={sendChanges}><Icon name={conflicts.length ? 'conflict' : 'chat'} size={13} />{conflicts.length ? ui('Send conflict analysis to chat') : ui('Send changes to chat')}</button></div>
          {conflicts.length > 0 && <div className="gv-banner"><Icon name="conflict" size={13} />{conflicts.length > 1 ? ui('{count} files have merge conflicts; resolve them first', { count: conflicts.length }) : ui('A file has merge conflicts; resolve it first')}</div>}
          {group(ui('Merge conflicts'), conflicts, 'conflict')}
          {group(ui('Staged changes'), staged, 'staged')}
          {group(ui('Changes'), unstaged, 'unstaged')}
          {inline && <div className="gv-inline-diff">
            <div className="gv-inline-diff-head"><span>{ui('Diff')}: {inline.path}</span>
              <button type="button" className="gv-btn" disabled={!inline.text} onClick={() => ask(ui('Please review this diff of `{file}`:\n```diff\n{diff}\n```', { file: inline.path, diff: (inline.text ?? '').slice(0, 8000) }))}>
                <Icon name="chat" size={13} />{ui('Send the diff to chat')}</button>
              <button type="button" className="gv-btn" aria-label={ui('Close')} onClick={() => setInline(undefined)}><Icon name="close" size={13} /></button></div>
            {inline.text === undefined ? <p className="gv-empty">{ui('Loading…')}</p> : inline.text ? <DiffLines text={inline.text} /> : <p className="gv-empty">{ui('No differences')}</p>}
          </div>}
        </div>}
      </div>
    </>}
    <div className="gv-body">
      {notice && <div className="gv-notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>
        <div className="gv-notice-row"><span>{notice.tone === 'progress' && <span className="gv-spinner" />}{notice.text}</span>
          {busy ? <button type="button" className="gv-btn" data-tone="danger" onClick={cancel}><Icon name="close" size={12} />{ui('Cancel')}</button>
            : <button type="button" className="gv-act" style={{ opacity: 1 }} aria-label={ui('Dismiss')} onClick={() => updateFolder(cwd, { notice: undefined })}><Icon name="close" size={12} /></button>}</div>
        {notice.auth && !busy && <SignIn sessionId={sessionId} auth={notice.auth} location={location} onSaved={retry} onClose={() => updateFolder(cwd, { notice: undefined })} />}
      </div>}
      {!view ? (loading ? <p className="gv-empty">{ui('Loading…')}</p> : <p className="gv-warn">{failure || ui('Loading…')}</p>)
        : tab === 'branches' ? <>
          {failure && <p className="gv-warn">{failure}</p>}
          <input className="gv-input gv-search" aria-label={ui('Search branches or commits')} placeholder={ui('Search branches or commits…')} value={search} onChange={e => setSearch(e.target.value)} />
          {([[ui('Local branches'), view.local, false, ui('No local branches')], [ui('Remote branches'), view.remote, true, ui('No remote branches')]] as const).map(([title, list, remote, empty]) => {
            const shown = list.filter(matches);
            return <section key={title} aria-label={title}><div className="gv-section">{title} ({shown.length})</div>
              {shown.length ? shown.map(branch => <BranchRow key={branch.name} branch={branch} remote={remote} busy={busy} pulling={pending === 'pull'} onActivate={activate} onPull={pull} onMenu={openMenu} />)
                : <p className="gv-empty">{empty}</p>}</section>;
          })}
          <div style={{ padding: 8 }}><button type="button" className="gv-btn" disabled={busy} onClick={() => void run('fetch', 'fetch')}><Icon name="fetch" size={13} />{spin('fetch', ui('Fetching…')) ?? ui('Fetch all')}</button></div>
        </> : <Graph commits={view.commits} tips={view.tips} current={view.current} width={width} busy={busy}
          onCherryPick={sha => void run('cherryPick', 'cherryPick', { sha })} onRevert={sha => void run('revert', 'revert', { sha })} />}
    </div>
    {menu && <>
      <div className="gv-menu-backdrop" onClick={() => setMenu(undefined)} onContextMenu={event => { event.preventDefault(); setMenu(undefined); }} />
      <div className="gv-menu" role="menu" aria-label={menu.branch.name} style={{ left: menu.x, top: menu.y }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(undefined); } }}>
        {menu.mode === 'rename' ? <form onSubmit={event => {
          event.preventDefault();
          const to = renameTo.trim(), from = menu.branch.name;
          setMenu(undefined);
          if (to && to !== from) void run('rename', 'rename', { branch: from, to });
        }}>
          <div className="gv-menu-title">{ui('Rename branch {name}', { name: menu.branch.name })}</div>
          <input className="gv-input" aria-label={ui('New branch name')} value={renameTo} autoFocus onChange={e => setRenameTo(e.target.value)} />
          <div className="gv-menu-actions"><button type="submit" className="gv-btn">{ui('Rename')}</button><button type="button" className="gv-btn" onClick={() => setMenu({ ...menu, mode: 'main' })}>{ui('Cancel')}</button></div>
        </form> : menu.mode === 'delete' ? <>
          <div className="gv-menu-title">{menu.remote ? ui('Delete the remote branch {name}?', { name: menu.branch.name }) : ui('Delete the branch {name}?', { name: menu.branch.name })}</div>
          <div className="gv-menu-actions">
            <button type="button" className="gv-btn" data-tone="danger" autoFocus onClick={() => { const { branch, remote } = menu; setMenu(undefined); void run(remote ? 'deleteRemoteBranch' : 'deleteBranch', remote ? 'deleteRemoteBranch' : 'deleteBranch', { branch: branch.name }); }}>{ui('Delete')}</button>
            <button type="button" className="gv-btn" onClick={() => setMenu({ ...menu, mode: 'main' })}>{ui('Cancel')}</button></div>
        </> : <>
          <button type="button" role="menuitem" autoFocus onClick={() => { copy(menu.branch.name, ui('Branch name copied')); setMenu(undefined); }}><Icon name="copy" size={13} />{ui('Copy branch name')}</button>
          {menu.branch.current && <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); void run('pull', 'pull'); }}><Icon name="arrowDown" size={13} />{ui('Pull')}</button>}
          <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenu(undefined); void run('fetch', 'fetch'); }}><Icon name="fetch" size={13} />{ui('Fetch all')}</button>
          {!menu.remote && <button type="button" role="menuitem" disabled={busy} onClick={() => setMenu({ ...menu, mode: 'rename' })}><Icon name="edit" size={13} />{ui('Rename…')}</button>}
          {!menu.branch.current && <button type="button" role="menuitem" disabled={busy} onClick={() => { const name = menu.branch.name; setMenu(undefined); void run('merge', 'merge', { branch: name }); }}><Icon name="both" size={13} />{ui('Merge into the current branch')}</button>}
          {!menu.branch.current && <button type="button" role="menuitem" data-tone="danger" disabled={busy} onClick={() => setMenu({ ...menu, mode: 'delete' })}><Icon name="close" size={13} />{menu.remote ? ui('Delete remote branch') : ui('Delete branch')}</button>}
        </>}
      </div>
    </>}
  </div>;
}
