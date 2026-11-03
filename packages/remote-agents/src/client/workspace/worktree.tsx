import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { DesktopIcon } from '@phosphor-icons/react/dist/csr/Desktop';
import { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives';
import { MinusCircleIcon } from '@phosphor-icons/react/dist/csr/MinusCircle';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveCheck, JobAction, JobMessage, WorktreeJob, WorktreeProject, WorktreeProjectDetail } from '../../workspace/worktrees.js';
import { api } from '../api.js';
import { localizeError, ui } from '../i18n.js';
import { PopoverSelect, type SelectOption } from './select.js';

const PROJECT_KEY = 'dsh-remote-agents.worktree.project', MODE_KEY = 'dsh-remote-agents.worktree.mode';
const recall = (key: string) => { try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } };
/** A reason is itself a message the host wrote, translated when it is a known one. */
const message = (value: JobMessage) => ui(value.key, value.values && Object.fromEntries(Object.entries(value.values).map(([name, text]) => [name, name === 'reason' ? ui(text) : text])));
const STEP_LABELS: Record<string, string> = {
  prepare: 'Check the branch', checkout: 'Check out files', register: 'Add to DSH', setup: 'Run setup',
  sessions: 'Archive its sessions', teardown: 'Run teardown', remove: 'Remove the worktree', branch: 'Delete the branch', unregister: 'Remove from DSH',
};
const ACTION_LABELS: Record<JobAction, string> = { cancel: 'Stop', retry: 'Retry', skip: 'Skip the remaining setup', discard: 'Delete this worktree' };
const where = (project: Pick<WorktreeProject, 'location'>) => project.location.kind === 'remote' ? project.location.host : ui('This computer');
/** A path under the machine's home folder as `~/…`. */
const tilde = (path: string, home?: string) => home && home !== '/' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** One running or finished operation: its steps, the live log, and what can be done next. */
function JobProgress({ job, title, onAction, onBack, onOpen }: { job: WorktreeJob; title: string; onAction(action: JobAction): void; onBack(): void; onOpen?(): void }) {
  const log = useRef<HTMLPreElement>(null), pinned = useRef(true);
  useLayoutEffect(() => { const element = log.current; if (element && pinned.current) element.scrollTop = element.scrollHeight; }, [job.log]);
  const running = job.state === 'running', stoppable = running && job.steps.some(s => s.state === 'running' && (s.id === 'setup' || s.id === 'teardown'));
  return <div className="ra-wt-job" aria-live="polite">
    <h3>{title}</h3>
    <ol className="ra-wt-steps">
      {job.steps.map(step => <li key={step.id} data-state={step.state}>
        {step.state === 'done' ? <CheckCircleIcon size={16} weight="fill" /> : step.state === 'failed' ? <XCircleIcon size={16} weight="fill" />
          : step.state === 'skipped' ? <MinusCircleIcon size={16} /> : step.state === 'running' ? <span className="ra-wt-spinner" role="status" /> : <CircleIcon size={16} />}
        <span>{ui(STEP_LABELS[step.id] ?? step.id)}</span>{step.detail && <small className="ra-mono">{step.detail}</small>}
      </li>)}
    </ol>
    {job.log && <pre ref={log} className="ra-wt-log" tabIndex={0} aria-label={ui('Output')}
      onScroll={event => { const e = event.currentTarget; pinned.current = e.scrollHeight - e.scrollTop - e.clientHeight < 24; }}>{job.log}</pre>}
    {job.error && <div className="ra-banner" data-tone="error" role="alert"><span>{message(job.error)}{job.error.detail && !job.log.includes(job.error.detail) && <small className="ra-mono ra-wt-detail">{job.error.detail}</small>}</span></div>}
    {job.result?.warnings.map((warning, i) => <div key={i} className="ra-banner" role="status"><span>{message(warning)}</span></div>)}
    <div className="ra-flow-foot">
      {running ? <span className="ra-muted ra-wt-note">{ui('You can close this window; the work continues.')}</span>
        : <button type="button" onClick={onBack}><ArrowLeftIcon size={15} />{ui('Back')}</button>}
      <div className="ra-actions">
        {stoppable && <button type="button" onClick={() => onAction('cancel')}>{ui('Stop')}</button>}
        {job.state === 'failed' && job.actions.map(action => <button key={action} type="button" className={action === 'retry' ? 'ra-primary' : action === 'discard' ? 'ra-danger' : undefined} onClick={() => onAction(action)}>{ui(action === 'skip' && job.kind === 'archive' ? 'Skip teardown' : ACTION_LABELS[action])}</button>)}
        {job.state === 'done' && onOpen && <button type="button" className="ra-primary" onClick={onOpen}><ArrowSquareOutIcon size={15} />{ui('Open workspace')}</button>}
      </div>
    </div>
  </div>;
}

/** What archiving a worktree removes, and the one choice it offers: deleting a merged branch. */
function ArchiveConfirm({ project, worktree, onCancel, onArchived }: { project: string; worktree: string; onCancel(): void; onArchived(job: WorktreeJob): void }) {
  const [check, setCheck] = useState<ArchiveCheck>(), [error, setError] = useState(''), [deleteBranch, setDeleteBranch] = useState(false), [pending, setPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    // The branch is kept unless deleting it is asked for; only a merged one can be.
    api<ArchiveCheck>('worktreeArchiveCheck', { path: project, worktree }, controller.signal).then(setCheck,
      failure => { if (!controller.signal.aborted) setError(localizeError(failure)); });
    return () => controller.abort();
  }, [project, worktree]);
  const sessions = check?.workspaces.reduce((count, workspace) => count + workspace.sessions, 0) ?? 0;
  const archive = async () => {
    setPending(true); setError('');
    try { onArchived(await api<WorktreeJob>('archiveWorktree', { path: project, worktree, deleteBranch: deleteBranch && !!check?.mergedInto })); }
    catch (failure) { setError(localizeError(failure)); setPending(false); }
  };
  return <div className="ra-wt-job">
    <h3>{ui('Archive {name}?', { name: check?.branch ?? worktree.split('/').pop() ?? '' })}</h3>
    {!check && !error && <p className="ra-muted" role="status">{ui('Checking the worktree…')}</p>}
    {check && <ul className="ra-wt-risks">
      {check.dirty > 0 && <li data-tone="warn">{ui('{count} changed or new files will be deleted', { count: String(check.dirty) })}</li>}
      {!!check.unpushed && <li data-tone="warn">{ui('{count} commits are not on any remote', { count: String(check.unpushed) })}</li>}
      {check.unpushed === null && <li data-tone="warn">{ui('This repository has no remote, so its commits exist only on this branch')}</li>}
      {check.dirty === 0 && !check.unpushed && check.unpushed !== null && <li>{ui('No unsaved work: every change is committed and pushed')}</li>}
      {check.workspaces.length > 0 && <li>{sessions ? ui('Its DSH workspace and {count} conversations will be archived', { count: String(sessions) }) : ui('Its DSH workspace will be removed')}</li>}
      {check.teardown.length > 0 && <li>{ui('{count} teardown commands run first', { count: String(check.teardown.length) })}</li>}
    </ul>}
    {check?.branch && <label className="ra-wt-check">
      <input type="checkbox" checked={deleteBranch && !!check.mergedInto} disabled={!check.mergedInto} onChange={event => setDeleteBranch(event.target.checked)} />
      <span>{ui('Also delete branch {branch}', { branch: check.branch })}<small>{check.mergedInto ? ui('Merged into {base}', { base: check.mergedInto }) : ui('Not merged, so the branch is kept')}</small></span>
    </label>}
    {error && <div className="ra-banner" data-tone="error" role="alert">{error}</div>}
    <div className="ra-flow-foot">
      <button type="button" onClick={onCancel}><ArrowLeftIcon size={15} />{ui('Back')}</button>
      <button type="button" className="ra-primary ra-danger-fill" disabled={!check || pending} onClick={() => void archive()}><ArchiveIcon size={15} />{ui('Archive')}</button>
    </div>
  </div>;
}

/**
 * Add workspace › From a project: choose a project, start a branch or check one out, and open the worktree as a new
 * workspace. The project's worktrees are listed below, to open or archive.
 */
export function ProjectFlow({ projects, busy, onPicked }: { projects: WorktreeProject[] | undefined; busy: boolean; onPicked(path: string): void }) {
  const [path, setPath] = useState(() => recall(PROJECT_KEY));
  const project = projects?.find(p => p.path === path) ?? projects?.[0];
  const [detail, setDetail] = useState<WorktreeProjectDetail>(), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [mode, setMode] = useState<'new' | 'existing'>(() => recall(MODE_KEY) === 'existing' ? 'existing' : 'new');
  const [base, setBase] = useState<string>(), [name, setName] = useState(''), [existing, setExisting] = useState<string>();
  // The branch an operation is about; its title follows the operation's kind.
  const [job, setJob] = useState<WorktreeJob>(), [jobName, setJobName] = useState(''), [archiving, setArchiving] = useState<string>(), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    setDetail(undefined); setError('');
    api<WorktreeProjectDetail>('worktreeInspect', { path: project.path }, controller.signal).then(value => {
      setDetail(value); setBase(current => value.branches.some(b => b.name === current) ? current : value.defaultBase ?? undefined);
      setExisting(current => value.branches.some(b => b.name === current && !b.checkedOutAt) ? current : undefined);
    }, failure => { if (!controller.signal.aborted) setError(localizeError(failure)); });
    return () => controller.abort();
  }, [project?.path, reload]);
  // A running operation is polled until it ends; a finished create opens its workspace unless it has warnings to read.
  useEffect(() => {
    if (job?.state !== 'running') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<WorktreeJob>('worktreeJob', { jobId: job.id }, controller.signal).then(next => {
        setJob(next);
        if (next.kind === 'create' && next.state === 'done' && next.result?.path && !next.result.warnings.length) onPicked(next.result.path);
        const name = jobName || next.result?.branch || '';
        // A finished archive or discard goes back to the project, unless there is a warning to read first.
        if ((next.kind === 'archive' && next.state === 'done' && !next.result?.warnings.length) || next.state === 'discarded') {
          setJob(undefined); setNotice(ui(next.state === 'discarded' ? 'Deleted {name}' : 'Archived {name}', { name })); setReload(n => n + 1);
        }
      }, failure => { if (!controller.signal.aborted) setJob({ ...job, state: 'failed', error: { key: localizeError(failure) }, actions: [] }); });
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [job]);
  const branchOptions = useMemo<SelectOption[]>(() => (detail?.branches ?? []).map(branch => {
    const marks = [branch.ahead ? `↑${branch.ahead}` : '', branch.behind ? `↓${branch.behind}` : ''].filter(Boolean);
    const taken = mode === 'existing' && branch.checkedOutAt, remote = branch.remote?.slice(0, branch.remote.length - branch.name.length - 1);
    return { id: branch.name, label: branch.name, marks, icon: <GitBranchIcon size={15} />, disabled: !!taken,
      ...(taken ? { note: ui('Checked out at {path}', { path: tilde(branch.checkedOutAt!, detail?.home) }) } : branch.local ? {} : { detail: ui('Only on {remote}', { remote: remote || branch.remote || '' }) }) };
  }), [detail, mode]);
  if (projects === undefined) return <div className="ra-flow-note" role="status">{ui('Looking for Git projects…')}</div>;
  if (!projects.length || !project) return <div className="ra-flow-local"><p className="ra-muted">{ui('No Git projects yet. Add a folder that is in a Git repository first, on this computer or a remote machine.')}</p></div>;
  const act = async (action: JobAction) => {
    if (!job) return;
    try { setJob(await api<WorktreeJob>('worktreeJobAction', { jobId: job.id, jobAction: action })); }
    catch (failure) { setJob({ ...job, error: { key: localizeError(failure) } }); }
  };
  const back = () => { setJob(undefined); setReload(n => n + 1); };
  // A generated branch name is known once the branch is checked.
  const named = jobName || job?.result?.branch || '';
  const jobTitle = job?.kind === 'archive' ? ui(job.state === 'done' ? 'Archived {name}' : 'Archiving {name}', { name: named })
    : !named ? ui('Creating a workspace') : ui(job?.state === 'done' ? 'Created {name}' : 'Creating {name}', { name: named });
  if (job) return <JobProgress job={job} title={jobTitle} onAction={action => void act(action)} onBack={back}
    onOpen={job.kind === 'create' && job.result?.path ? () => onPicked(job.result!.path!) : undefined} />;
  if (archiving) return <ArchiveConfirm project={project.path} worktree={archiving} onCancel={() => setArchiving(undefined)}
    onArchived={started => { setJobName(detail?.worktrees.find(w => w.path === archiving)?.branch ?? archiving.split('/').pop() ?? ''); setArchiving(undefined); setJob(started); }} />;
  const branch = mode === 'new' ? name.trim() : existing;
  const create = async () => {
    setError(''); setNotice('');
    try {
      const started = await api<WorktreeJob>('createWorktree', { path: project.path, mode, ...(mode === 'new' ? { base, branch: name.trim() } : { branch: existing }) });
      setJobName(branch ?? ''); setJob(started);
    } catch (failure) { setError(localizeError(failure)); }
  };
  const projectOptions: SelectOption[] = projects.map(p => ({ id: p.path, label: p.title, marks: [where(p)], detail: tilde(p.folder, p.home),
    icon: p.location.kind === 'remote' ? <HardDrivesIcon size={15} /> : <DesktopIcon size={15} /> }));
  const locked = busy || !detail;
  return <div className="ra-wt">
    <PopoverSelect label={ui('Project')} options={projectOptions} value={project.path} placeholder={ui('Choose a project…')} search={projects.length > 8}
      icon={<DesktopIcon size={15} />} disabled={busy} onChange={next => { setPath(next); remember(PROJECT_KEY, next); setNotice(''); }} />
    {error && !detail && <div className="ra-banner" data-tone="error" role="alert">{error}<button type="button" onClick={() => setReload(n => n + 1)}>{ui('Retry')}</button></div>}
    {!detail && !error && <div className="ra-flow-note" role="status">{ui('Reading branches…')}</div>}
    {detail && <>
      <div className="ra-wt-segment" role="radiogroup" aria-label={ui('Branch')}>
        {(['new', 'existing'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={busy}
          onClick={() => { setMode(value); remember(MODE_KEY, value); }}>{ui(value === 'new' ? 'New branch' : 'Existing branch')}</button>)}
      </div>
      {mode === 'new' ? <div className="ra-wt-row">
        <PopoverSelect label={ui('Start from')} options={branchOptions} value={base} placeholder={ui('Choose a branch…')} search icon={<GitBranchIcon size={15} />} disabled={locked} onChange={setBase} />
        <label className="ra-field"><span>{ui('New branch name')}</span>
          <input className="ra-mono ra-wt-input" value={name} placeholder={ui('Leave empty for a generated name')} spellCheck={false} autoComplete="off" disabled={locked}
            onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && base) void create(); }} /></label>
      </div>
        : <PopoverSelect label={ui('Branch to check out')} options={branchOptions} value={existing} placeholder={ui('Choose a branch…')} search icon={<GitBranchIcon size={15} />} disabled={locked} onChange={setExisting} />}
      <p className="ra-foot ra-wt-where">{ui('The worktree goes in {path}', { path: `${tilde(detail.root, detail.home)}/…` })}{detail.location.kind === 'remote' && ` · ${ui('on {host}', { host: detail.location.host })}`}</p>
      {detail.setup.length > 0 && <details className="ra-wt-setup"><summary>{ui('Then runs {count} setup commands from .dsh/worktree.json', { count: String(detail.setup.length) })}</summary>
        <pre className="ra-mono">{detail.setup.map(command => `$ ${command}`).join('\n')}</pre></details>}
      {error && <div className="ra-banner" data-tone="error" role="alert">{error}</div>}
      {notice && <div className="ra-banner" role="status">{notice}</div>}
      <div className="ra-flow-foot"><span />
        <button type="button" className="ra-primary" disabled={locked || (mode === 'new' ? !base : !existing)} onClick={() => void create()}><GitBranchIcon size={15} />{ui('Create workspace')}</button>
      </div>
      {detail.worktrees.length > 0 && <section className="ra-wt-list" aria-label={ui('Worktrees of this project')}>
        <h4>{ui('Worktrees of this project')}<span>{detail.worktrees.length}</span></h4>
        <ul>{detail.worktrees.map(worktree => <li key={worktree.path}>
          <GitBranchIcon size={15} />
          <span className="ra-wt-list-main"><span>{worktree.branch ?? ui('Detached HEAD')}</span><small className="ra-mono" title={tilde(worktree.path, detail.home)}>{worktree.workspace?.title ?? ui('Not in DSH')}</small></span>
          <button type="button" className="ra-wt-icon" aria-label={ui('Open workspace')} title={ui('Open workspace')} disabled={busy} onClick={() => {
            const location = detail.location;
            if (worktree.workspace) onPicked(worktree.workspace.path);
            else if (location.kind === 'local') onPicked(worktree.path);
            else void api<{ path: string }>('createWorkspace', { hostId: location.hostId, path: worktree.path }).then(w => onPicked(w.path), failure => setError(localizeError(failure)));
          }}><ArrowSquareOutIcon size={15} /></button>
          <button type="button" className="ra-wt-icon" aria-label={ui('Archive')} title={ui('Archive')} disabled={busy} onClick={() => { setNotice(''); setArchiving(worktree.path); }}><ArchiveIcon size={15} /></button>
        </li>)}</ul>
      </section>}
    </>}
  </div>;
}
