import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Item, Message, Route, Task, TaskStatus } from '../domain.js';
import type { PoolView } from '../service.js';
import { call, type State } from './api.js';
import { useFlowCard, type FlowView, type Stage, type ViewExtras } from './flowcard.js';
import { formatLocale, ui, useLocale } from './i18n.js';
import { sourceText } from './needs.js';
import { NewBugForm, type NewBug } from './newbug.js';
import { Pick } from './pick.js';
import { usePictures } from './pictures.js';

const REFRESH_MS = 3000;
type TaskView = State['tasks'][number];
interface ProjectInfo { branches: string[]; packages: string[]; defaultBase: string | null }

export const failure = (reason: unknown): Message => (reason as { said?: Message }).said ?? { key: reason instanceof Error ? reason.message : String(reason) };
const statusText = (status: TaskStatus): string => ({
  preparing: ui("Preparing the worktree"), working: ui("Models are working"), checking: ui("Running checks"), review: ui("Waiting for you"),
  accepting: ui("Merging and pushing"), done: ui("Done"), failed: ui("Failed"), stopped: ui("Stopped"),
})[status];
const ago = (at: number | undefined): string => {
  if (!at) return ui("never");
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return ui("just now");
  if (minutes < 60) return ui("{0} min ago", { 0: String(minutes) });
  return new Date(at).toLocaleString(formatLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
/** A server message in the page's language; its raw output stays as it is. */
const told = (message: Message) => ui(message.key, message.values);
export function Said({ message, error }: { message: Message; error?: boolean }) {
  return <div className={error ? 'tp-error' : 'tp-muted'} role={error ? 'alert' : undefined}>{told(message)}{message.detail && <pre>{message.detail}</pre>}</div>;
}
/** A source's name; the built-in one for typed bugs is said in the page's language. */
const sourceLabel = (name: string) => name === 'Manual' ? ui("Typed in") : name;
/** Where a task came from: its source, or /flow for something to build. */
const originLabel = (task: TaskView) => task.item.kind === 'feature' ? ui("From /flow") : sourceLabel(task.sourceName);

/**
 * A task's newest flow as the flow's own card draws it, from what the task keeps of it. Undefined for a task that has
 * no flow yet, or whose flow ran before tasks kept what the card needs.
 */
function flowOf(task: TaskView, far: boolean, act: (action: string) => Promise<boolean>): FlowView | undefined {
  const flow = task.flow, live = task.progress;
  if (!flow || flow.rounds === undefined) return undefined;
  const active = task.running && task.status === 'working' && !flow.end;
  // Another DSH's clock is not this one's: a flow followed from afar shows no running time.
  const elapsed = live?.elapsed ?? (active && !far && flow.startedAt ? Math.max(0, Date.now() - flow.startedAt) : undefined);
  return {
    card: { parentId: far ? '' : task.sessionId ?? '', zh: flow.zh ?? false, rounds: flow.rounds, ...(flow.planned !== undefined ? { planned: flow.planned } : {}), steps: live?.steps ?? flow.steps, ...(flow.end ? { end: flow.end } : {}),
      ...(elapsed !== undefined ? { elapsed } : {}), ...(live?.activity ? { activity: live.activity } : {}) },
    active, canOpen: !far && !!task.sessionId,
    ...(active ? { stop: () => { void act('stop'); } } : {}),
    ...(far ? {} : { stepBody: (index: number) => call<{ body: string | null }>('stepBody', { key: task.key, index }).then(reply => reply.body ?? null, () => null) }),
  };
}
/** What follows the flow, at the end of its progress bar: the repository's checks, then the person. */
function stagesOf(task: TaskView): Stage[] {
  const passed = task.flow?.end?.kind === 'passed', after = task.status === 'review' || task.status === 'accepting' || task.status === 'done';
  const over = !!task.flow?.end && !passed || task.status === 'failed' || task.status === 'stopped';
  const failedCheck = task.check?.runs.some(run => run.code !== 0);
  const checks: Stage['status'] = task.status === 'checking' ? 'running' : after ? 'passed' : failedCheck ? 'failed' : over ? 'skipped' : 'pending';
  const accept: Stage['status'] = task.status === 'accepting' ? 'running' : task.status === 'done' ? 'passed' : over ? 'skipped' : 'pending';
  return [{ label: ui("Checks"), status: checks }, { label: ui("Acceptance"), status: accept }];
}
/** The top of the card once the flow has passed and the task goes on without it; before that the flow speaks for itself. */
function headOf(task: TaskView): ViewExtras['head'] {
  const end = task.flow?.end;
  if (end?.kind !== 'passed') return undefined;
  const round = ui("Review passed in round {round}", { round: String(end.round) });
  switch (task.status) {
    case 'checking': return { status: 'running', title: ui("Running checks"), detail: round, clock: null };
    case 'review': return { status: 'passed', title: ui("Waiting for you"), detail: [round, task.commit && ui("committed {0}", { 0: task.commit.slice(0, 9) })].filter(Boolean).join(' · '), clock: end.ms };
    case 'accepting': return { status: 'running', title: ui("Merging and pushing"), detail: round, clock: null };
    case 'done': return { status: 'passed', title: task.mergeCommit ? ui("Merged into {0} as {1}", { 0: task.baseBranch, 1: task.mergeCommit.slice(0, 9) }) : ui("Branch {0} pushed", { 0: task.branch ?? '' }), detail: round, clock: end.ms };
    case 'failed': return { status: 'failed', title: ui("Failed"), detail: task.error ? ui(task.error.key, task.error.values) : round, clock: null };
    case 'stopped': return { status: 'stopped', title: ui("Stopped"), detail: round, clock: null };
    default: return undefined;
  }
}
const seconds = (ms: number) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function Diff({ taskKey, at }: { taskKey: string; at?: string }) {
  const [diff, setDiff] = useState<{ stat: string; patch: string; truncated: boolean }>(), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    call<{ stat: string; patch: string; truncated: boolean }>('diff', { key: taskKey, ...(at ? { at } : {}) }, controller.signal).then(setDiff, reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [taskKey]);
  if (error) return <p className="tp-error">{error}</p>;
  if (!diff) return <p className="tp-muted">{ui("Loading…")}</p>;
  if (!diff.patch.trim()) return <p className="tp-muted">{ui("No changes compared with the base branch.")}</p>;
  return <div className="tp-diff"><pre className="tp-stat">{diff.stat.trimEnd()}</pre>
    <pre>{diff.patch.split('\n').map((line, index) => <span key={index} data-kind={line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'file' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : undefined}>{line}{'\n'}</span>)}</pre>
    {diff.truncated && <p className="tp-muted">{ui("The rest is too long to show here. Open the conversation's workspace to read it all.")}</p>}
  </div>;
}

/** A bug's short name and title; a link when its source has a page for it. */
function Title({ item }: { item: Item }) {
  const text = `${item.ref} · ${item.title}`;
  return item.url ? <a className="tp-title" href={item.url} target="_blank" rel="noreferrer">{text}</a> : <span className="tp-title">{text}</span>;
}

/**
 * A task with what can be done about it. `keep` leaves out removing it: a card in a conversation is not where a task is
 * thrown away. `at` is set for a task another DSH runs. `flow` is the card of the task's flow in its own conversation,
 * live as Model flow draws it; anywhere else the task is drawn from what it keeps of its flow.
 */
export function TaskCard({ task, routes, busy, act, open, keep, at, flow }: { task: TaskView; routes: readonly Pick<Route, 'id' | 'name' | 'accept'>[]; busy: boolean; act(action: string, body?: Record<string, unknown>): Promise<boolean>; open?(sessionId: string): void; keep?: boolean; at?: string; flow?: FlowView }) {
  const [mode, setMode] = useState<'idle' | 'back' | 'accept' | 'remove'>('idle'), [note, setNote] = useState(''), [showDiff, setShowDiff] = useState(false), added = usePictures();
  const route = routes.find(entry => entry.id === task.routeId), last = task.events.at(-1);
  const review = task.status === 'review', trouble = task.status === 'failed' || task.status === 'stopped', done = task.status === 'done';
  // The worktree a finished fix was made in has no more use; it goes only when a person says so.
  const removable = done && !!task.worktree && !task.running, accepted = useRef(false);
  // The card a fix was accepted on asks about its workspace by itself, once the fix is out.
  useEffect(() => { if (removable && accepted.current) { accepted.current = false; setMode('remove'); } }, [removable]);
  useEffect(() => { if (mode === 'remove' && !removable) setMode('idle'); }, [mode, removable]);
  const send = async () => { if (await act('sendBack', { feedback: note, images: added.payload() })) { setNote(''); added.clear(); setMode('idle'); } };
  // Drawn as the flow's own card when Model flow's page offers it: the same progress a /flow shows, then what a task adds.
  const View = useFlowCard()?.View, view = View ? flow ?? flowOf(task, !!at, action => act(action)) : undefined;
  const meta = <p className="tp-meta">{[originLabel(task), route?.name ?? task.routeId, task.branch && `${task.branch} ← ${task.baseBranch}`, task.commit && task.commit.slice(0, 9), task.attempts > 1 && ui("round {0}", { 0: String(task.attempts) })].filter(Boolean).join(' · ')}</p>;
  // The flow says what it is doing itself; the task's own last word is for the time around it.
  const flowing = !!view && (view.active || (!!view.card.end && task.status === 'working'));
  const body = <>
    {task.error && !(view && task.status === 'failed' && task.flow?.end?.kind === 'passed' && !task.error.detail) && <Said message={task.error} error />}
    {!task.error && !review && (!done || task.running) && !flowing && last && <p className="tp-muted">{told(last.said)}</p>}
    {task.check && (task.check.runs.length > 0 || task.check.warnings.length > 0) && <ul className="tp-checks">
      {task.check.runs.map((run, index) => <li key={index} data-ok={run.code === 0}><code>{run.command}</code><span>{run.code === 0 ? ui("passed") : ui("failed")} · {seconds(run.ms)}</span></li>)}
      {task.check.warnings.map((warning, index) => <li key={`w${index}`} data-warning>{told(warning)}</li>)}
    </ul>}
    {done && !view && <p className="tp-muted">{task.mergeCommit ? ui("Merged into {0} as {1}", { 0: task.baseBranch, 1: task.mergeCommit.slice(0, 9) }) : ui("Branch {0} pushed", { 0: task.branch ?? '' })}{!task.worktree && ` · ${ui("workspace removed")}`}</p>}
    {done && view && !task.worktree && <p className="tp-muted">{ui("workspace removed")}</p>}
    {task.reportPending && <p className="tp-error">{ui("{0} was not told that this was accepted.", { 0: sourceLabel(task.sourceName) })}</p>}
    {task.flow?.report && (review || trouble) && !(view && (flow || keep)) && <details className="tp-report"><summary>{ui("What the models reported")}</summary><div>{task.flow.report}</div></details>}
    {review && <details className="tp-report" onToggle={event => setShowDiff((event.target as HTMLDetailsElement).open)}><summary>{ui("Changes")}{task.check ? ` · ${ui("{0} files", { 0: String(task.check.files.length) })}` : ''}</summary>{showDiff && <Diff taskKey={`${task.key}`} {...(at ? { at } : {})} />}</details>}
    {mode === 'back' && <div className="tp-form tp-back" {...added.zone}><textarea autoFocus rows={3} value={note} placeholder={ui("What should change? Paste or drop screenshots here.")} onChange={event => setNote(event.target.value)} />
      {added.view()}
      <div className="tp-actions"><button type="button" className="tp-button" data-primary disabled={busy || (review && !note.trim() && !added.pictures.length)} onClick={() => void send()}>{ui("Send back")}</button>
        <button type="button" className="tp-button" disabled={added.full} onClick={added.choose}>{ui("Add pictures")}</button><button type="button" className="tp-button" data-quiet onClick={() => setMode('idle')}>{ui("Cancel")}</button></div></div>}
    {mode === 'accept' && <div className="tp-form"><p>{task.item.source === 'manual'
        ? route?.accept === 'push-branch' ? ui("Push branch {0}?", { 0: task.branch ?? '' }) : ui("Merge into {0} and push it?", { 0: task.baseBranch })
        : route?.accept === 'push-branch' ? ui("Push branch {0} and tell {1} the bug is fixed?", { 0: task.branch ?? '', 1: task.sourceName }) : ui("Merge into {0}, push it, and tell {1} the bug is fixed?", { 0: task.baseBranch, 1: task.sourceName })}</p>
      <div className="tp-actions"><button type="button" className="tp-button" data-primary disabled={busy} onClick={() => void act('accept').then(ok => { if (ok) { accepted.current = true; setMode('idle'); } })}>{ui("Yes, accept")}</button><button type="button" className="tp-button" onClick={() => setMode('idle')}>{ui("Cancel")}</button></div></div>}
    {mode === 'remove' && <div className="tp-form"><p>{task.mergeCommit
        ? ui("Remove this task's workspace? Its worktree is deleted and its conversation archived. Branch {0} is deleted too, as it is merged.", { 0: task.branch ?? '' })
        : ui("Remove this task's workspace? Its worktree is deleted and its conversation archived. Branch {0} stays.", { 0: task.branch ?? '' })}</p>
      <div className="tp-actions"><button type="button" className="tp-button" data-danger disabled={busy} onClick={() => void act('removeWorkspace').then(() => setMode('idle'))}>{ui("Yes, remove it")}</button><button type="button" className="tp-button" onClick={() => setMode('idle')}>{ui("Keep it")}</button></div></div>}
    {mode === 'idle' && <div className="tp-actions">
      {review && <><button type="button" className="tp-button" data-primary disabled={busy} onClick={() => setMode('accept')}>{ui("Accept")}</button><button type="button" className="tp-button" disabled={busy} onClick={() => setMode('back')}>{ui("Send back")}</button></>}
      {trouble && task.sessionId && <><button type="button" className="tp-button" data-primary disabled={busy} onClick={() => void act('sendBack', { feedback: '' })}>{ui("Continue")}</button><button type="button" className="tp-button" disabled={busy} onClick={() => setMode('back')}>{ui("Continue with a note")}</button></>}
      {task.running && !view?.active && <button type="button" className="tp-button" disabled={busy} onClick={() => void act('stop')}>{ui("Stop")}</button>}
      {task.reportPending && <button type="button" className="tp-button" data-primary disabled={busy} onClick={() => void act('retryReport')}>{ui("Write back again")}</button>}
      {task.sessionId && open && <button type="button" className="tp-button" onClick={() => open(task.sessionId!)}>{ui("Open conversation")}</button>}
      {removable && <button type="button" className="tp-button" disabled={busy} onClick={() => setMode('remove')}>{ui("Remove workspace")}</button>}
      {(trouble || done) && !keep && <button type="button" className="tp-button" data-quiet disabled={busy} onClick={() => void act('forget')}>{ui("Remove")}</button>}
    </div>}
  </>;
  if (View && view) {
    // In a conversation the report is part of the card, as a flow's is; on the board it stays folded with the rest.
    const report = view.report ?? (keep && (review || trouble) ? task.flow?.report : undefined);
    return <div className="tp-flowcard" data-status={task.status}>
      <View {...view} {...(report ? { report } : {})} stages={stagesOf(task)} head={headOf(task)} caption={<><Title item={task.item} />{meta}</>}>{body}</View>
    </div>;
  }
  return <article className="tp-card" data-status={task.status}>
    <header>
      <Title item={task.item} />
      <span className="tp-state" data-status={task.status}>{task.running && <i aria-hidden="true" />}{statusText(task.status)}</span>
    </header>
    {meta}
    {body}
  </article>;
}

function PoolRow({ item, routes, info, busy, load, act, removable }: { item: PoolView; removable: boolean; routes: readonly Route[]; info(routeId: string): ProjectInfo | undefined; busy: boolean; load(route: Route): void; act(action: string, body?: Record<string, unknown>): Promise<boolean> }) {
  const route = routes.find(entry => entry.id === item.assignment?.routeId), details = route ? info(route.id) : undefined;
  useEffect(() => { if (route) load(route); }, [route?.id]);
  const assign = (change: Partial<{ routeId: string; branch: string; package: string }>) => {
    const next = { routeId: item.assignment?.routeId ?? '', branch: item.assignment?.branch ?? '', package: item.assignment?.package ?? '', ...change };
    if (change.routeId !== undefined) { next.branch = routes.find(entry => entry.id === change.routeId)?.defaultBranch ?? ''; next.package = ''; }
    return act('assign', { assignment: next.routeId ? next : null });
  };
  const branches = details ? [...new Set([item.assignment?.branch, ...details.branches].filter(Boolean) as string[])] : item.assignment?.branch ? [item.assignment.branch] : [];
  return <article className="tp-card" data-pool>
    <header><Title item={item.item} /></header>
    <p className="tp-meta">{[sourceLabel(item.sourceName), item.item.project?.name, item.item.status, item.item.priority, item.item.module, ...item.item.labels, item.item.images && ui("{0} pictures", { 0: String(item.item.images) })].filter(Boolean).join(' · ')}</p>
    <div className="tp-assign">
      <Pick label={ui("Repository")} value={item.assignment?.routeId ?? ''} placeholder={ui("Choose a repository…")} disabled={busy}
        options={routes.map(entry => ({ value: entry.id, label: entry.name }))} onChange={value => void assign({ routeId: value })} />
      {route && <Pick label={ui("Branch")} value={item.assignment?.branch ?? ''} disabled={busy} options={branches.map(branch => ({ value: branch, label: branch }))} onChange={value => void assign({ branch: value })} />}
      {route && route.packageGlobs.length > 0 && <Pick label={ui("Package")} value={item.assignment?.package ?? ''} disabled={busy} onChange={value => void assign({ package: value })}
        options={[{ value: '', label: ui("Package: let the models find it") }, ...[...new Set([item.assignment?.package, ...(details?.packages ?? [])].filter(Boolean) as string[])].map(path => ({ value: path, label: path }))]} />}
      <span className="tp-spacer" />
      <button type="button" className="tp-button" data-primary disabled={busy || !item.assignment} onClick={() => void act('start')}>{ui("Start")}</button>
      {removable
        ? <button type="button" className="tp-button" data-quiet disabled={busy} onClick={() => void act('discard')}>{ui("Delete")}</button>
        : <button type="button" className="tp-button" data-quiet disabled={busy} onClick={() => void act('dismiss', { dismissed: !item.dismissed })}>{item.dismissed ? ui("Restore") : ui("Ignore")}</button>}
    </div>
  </article>;
}

/** The pool and the tasks, newest state every few seconds while it is on screen. */
export function Board({ open }: { open?(sessionId: string): void }) {
  useLocale();
  const [state, setState] = useState<State>(), [error, setError] = useState<Message>(), [busy, setBusy] = useState<Record<string, boolean>>({});
  const projects = useRef<Record<string, ProjectInfo | 'loading'>>({}), [, redraw] = useState(0), [adding, setAdding] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => call('state').then(reply => { if (alive && reply.state) setState(reply.state); }, reason => { if (alive) setError(current => current ?? failure(reason)); });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const run = useCallback(async (id: string, action: string, body: Record<string, unknown> = {}): Promise<boolean> => {
    setBusy(current => ({ ...current, [id]: true })); setError(undefined);
    try { const reply = await call(action, body); if (reply.state) setState(reply.state); return true; }
    catch (reason) {
      const next = (reason as { state?: State }).state;
      if (next) setState(next);
      setError(failure(reason));
      return false;
    } finally { setBusy(current => ({ ...current, [id]: false })); }
  }, []);
  const loadProject = useCallback((route: Route) => {
    if (projects.current[route.id]) return;
    projects.current[route.id] = 'loading';
    call<ProjectInfo>('project', { path: route.project, globs: route.packageGlobs }).then(reply => { projects.current[route.id] = { branches: reply.branches ?? [], packages: reply.packages ?? [], defaultBase: reply.defaultBase ?? null }; redraw(value => value + 1); }, () => { delete projects.current[route.id]; });
  }, []);
  if (!state) return <div className="tp-board"><h2>{ui("Tasks")}</h2>{error ? <Said message={error} error /> : <p className="tp-muted">{ui("Loading…")}</p>}</div>;

  const { routes } = state.settings, tasks = new Map(state.tasks.map(task => [task.key, task]));
  const by = (...statuses: TaskStatus[]) => state.tasks.filter(task => statuses.includes(task.status));
  const review = by('review'), active = by('preparing', 'working', 'checking', 'accepting'), trouble = by('failed', 'stopped'), done = by('done');
  const free = state.pool.filter(item => !tasks.has(item.key)), waiting = free.filter(item => !item.dismissed && !item.stale), aside = free.filter(item => item.dismissed || item.stale);
  const info = (routeId: string) => { const value = projects.current[routeId]; return value && value !== 'loading' ? value : undefined; };
  const card = (task: TaskView) => <TaskCard key={task.key} task={task} routes={routes} busy={!!busy[task.key]} open={open} act={(action, body) => run(task.key, action, { key: task.key, ...body })} />;
  const asked = new Set(state.sources.filter(source => source.fetches).map(source => source.id));
  const row = (item: PoolView) => <PoolRow key={item.key} item={item} removable={!asked.has(item.item.source) || !!item.stale} routes={routes} info={info} load={loadProject} busy={!!busy[item.key]} act={(action, body) => run(item.key, action, { key: item.key, ...body })} />;
  const create = async (bug: NewBug, start: boolean): Promise<boolean> => {
    setBusy(current => ({ ...current, create: true })); setError(undefined);
    try {
      const made = await call<{ key: string }>('createManual', { bug });
      const reply = start ? await call('start', { key: made.key }) : made;
      if (reply.state) setState(reply.state);
      return true;
    } catch (reason) {
      const next = (reason as { state?: State }).state;
      if (next) setState(next);
      setError(failure(reason));
      return false;
    } finally { setBusy(current => ({ ...current, create: false })); }
  };
  const typed = state.sources.some(source => source.id === 'manual');
  const askable = state.sources.filter(source => source.fetches && !source.unready), fetching = !!busy.fetch || state.sources.some(source => source.busy);
  return <div className="tp-board">
    <header className="tp-top">
      <div><h2>{ui("Tasks")}</h2>
        {state.sources.filter(source => source.id !== 'manual').map(source => <p key={source.id} className={source.error || source.unready ? 'tp-error' : 'tp-muted'}>{source.name} · {source.unready ? sourceText(source.id, source.unready) : source.error ? ui("last fetch failed: {0}", { 0: source.error }) : source.fetches ? ui("fetched {0}", { 0: ago(source.at) }) : ui("hands bugs in by itself")}</p>)}</div>
      <div className="tp-actions">
        {typed && <button type="button" className="tp-button" disabled={adding} onClick={() => setAdding(true)}>{ui("New bug")}</button>}
        {askable.length > 0 && <button type="button" className="tp-button" data-primary disabled={fetching} onClick={() => void run('fetch', 'fetch')}>{fetching ? ui("Fetching…") : ui("Fetch")}</button>}
      </div>
    </header>
    {adding && <NewBugForm routes={routes} busy={!!busy.create} onSubmit={create} onCancel={() => setAdding(false)}
      branches={route => { loadProject(route); return info(route.id)?.branches ?? []; }} />}
    {error && <Said message={error} error />}
    {state.sources.every(source => source.id === 'manual') && !adding && state.pool.length === 0 && state.tasks.length === 0 && <p className="tp-empty">{ui("Type a bug in with New bug, or install a source such as dsh-tapd and its bugs appear here.")}</p>}
    {routes.length === 0 && <p className="tp-empty">{ui("Add a repository in Settings → Autofix so bugs have somewhere to go.")}</p>}
    {review.length > 0 && <section><h3>{ui("Waiting for you")}<span>{review.length}</span></h3>{review.map(card)}</section>}
    {active.length > 0 && <section><h3>{ui("Running")}<span>{active.length}</span></h3>{active.map(card)}</section>}
    {trouble.length > 0 && <section><h3>{ui("Needs a look")}<span>{trouble.length}</span></h3>{trouble.map(card)}</section>}
    <section><h3>{ui("To hand out")}<span>{waiting.length}</span></h3>
      {waiting.length ? waiting.map(row) : askable.length > 0 && !adding && <p className="tp-empty">{askable.some(source => source.at) ? ui("No open bugs.") : ui("Fetch to see the open bugs.")}</p>}</section>
    {done.length > 0 && <details className="tp-fold"><summary>{ui("Done")}<span>{done.length}</span></summary>{done.map(card)}</details>}
    {aside.length > 0 && <details className="tp-fold"><summary>{ui("Ignored or no longer open")}<span>{aside.length}</span></summary>{aside.map(row)}</details>}
  </div>;
}
export type { Task };
