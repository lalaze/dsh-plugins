import React, { useEffect, useRef, useState } from 'react';
import type { Route, Settings } from '../domain.js';
import { call, type State } from './api.js';
import { ui, useLocale } from './i18n.js';
import { Pick } from './pick.js';

type Form = State['settings'];
interface Project { path: string; title: string; location: { kind: 'local' } | { kind: 'remote'; host: string }; folder: string }
interface Branches { path: string; names: string[]; failed?: boolean }
type Note = { kind: 'ok' | 'error'; text: string };

const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
const words = (value: string) => value.split(/[,，\n]/u).map(word => word.trim()).filter(Boolean);
const emptyRoute = (): Route => ({ id: '', name: '', project: '', defaultBranch: '', tests: [], packageGlobs: [], sharedPaths: [], buildScripts: ['build:test', 'build-test', 'build'], preview: '', pushRemote: 'origin', accept: 'merge' });
/** What the server said, in the page's language when it can be. */
const told = (reason: unknown): string => {
  const said = (reason as { said?: { key: string; values?: Record<string, string> } }).said;
  return said ? ui(said.key, said.values) : reason instanceof Error ? reason.message : String(reason);
};
const machineOf = (project: Project) => project.location.kind === 'remote' ? project.location.host : ui("this computer");

const Chevron = () => <svg className="tp-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>;

/** One setting: what it is on the left, the control on the right; `stacked` puts a wide control underneath. */
function Row({ title, hint, stacked, children }: { title: string; hint?: React.ReactNode; stacked?: boolean; children?: React.ReactNode }) {
  return <div className="tp-row" data-stacked={stacked || undefined}>
    <div className="tp-row-text"><span>{title}</span>{hint && <small>{hint}</small>}</div>
    {children && <div className="tp-row-control">{children}</div>}
  </div>;
}
/** A short list of words as removable chips. Enter, a comma or leaving the box adds what was typed. */
function Chips({ label, value, onChange, placeholder }: { label: string; value: readonly string[]; onChange(next: string[]): void; placeholder?: string }) {
  const [draft, setDraft] = useState(''), input = useRef<HTMLInputElement>(null);
  const add = (typed: string) => { const more = words(typed).filter(word => !value.includes(word)); if (more.length) onChange([...value, ...more]); setDraft(''); };
  return <div className="tp-chips" onClick={event => { if (event.target === event.currentTarget) input.current?.focus(); }}>
    {value.map(word => <span key={word} className="tp-chip">{word}
      <button type="button" aria-label={ui("Remove {0}", { 0: word })} title={ui("Remove {0}", { 0: word })} onClick={() => onChange(value.filter(entry => entry !== word))}>×</button></span>)}
    <input ref={input} aria-label={label} value={draft} placeholder={value.length ? '' : placeholder} spellCheck={false}
      onChange={event => { if (/[,，\n]/u.test(event.target.value)) add(event.target.value); else setDraft(event.target.value); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); add(draft); }
        else if (event.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
      }}
      onBlur={() => { if (draft.trim()) add(draft); }} />
  </div>;
}
/** A small whole number with a button on each side. */
function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(next: number): void }) {
  return <div className="tp-stepper" role="group" aria-label={label}>
    <button type="button" aria-label={ui("Fewer")} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
    <output aria-live="polite">{value}</output>
    <button type="button" aria-label={ui("More")} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
  </div>;
}
/** A list a person types one per line; the text is theirs until they leave the box. */
function LinesInput({ label, value, onChange, placeholder }: { label: string; value: readonly string[]; onChange(next: string[]): void; placeholder?: string }) {
  const [draft, setDraft] = useState<string>();
  return <textarea aria-label={label} rows={Math.min(8, Math.max(3, (draft ?? value.join('\n')).split('\n').length))} value={draft ?? value.join('\n')} placeholder={placeholder} spellCheck={false}
    onChange={event => setDraft(event.target.value)} onBlur={() => { if (draft !== undefined) { onChange(lines(draft)); setDraft(undefined); } }} />;
}

/** A folder typed in, for a repository DSH has not opened yet. The folder is on the computer DSH runs on, which may not be the one showing this page. */
function FolderBox({ onAdded }: { onAdded(project: string, projects: Project[]): void }) {
  const [path, setPath] = useState(''), [busy, setBusy] = useState(false), [note, setNote] = useState<Note>();
  const add = async () => {
    if (!path.trim() || busy) return;
    setBusy(true); setNote(undefined);
    try {
      const reply = await call<{ project: string; projects: Project[]; remotes: string[] }>('addFolder', { path });
      onAdded(reply.project, reply.projects);
      setPath('');
      setNote(reply.remotes.length ? { kind: 'ok', text: ui("Added and chosen") } : { kind: 'error', text: ui("Added, but this repository has no remote: an accepted fix has nowhere to be pushed.") });
    } catch (reason) { setNote({ kind: 'error', text: told(reason) }); }
    finally { setBusy(false); }
  };
  return <div className="tp-folder">
    <div className="tp-inline">
      <input aria-label={ui("Folder path")} value={path} placeholder="~/code/project" spellCheck={false} disabled={busy} autoFocus onChange={event => setPath(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }} />
      <button type="button" className="tp-button" disabled={busy || !path.trim()} onClick={() => void add()}>{busy ? ui("Adding…") : ui("Add folder")}</button>
    </div>
    <small className={note?.kind === 'error' ? 'tp-error' : 'tp-muted'} role={note?.kind === 'error' ? 'alert' : 'status'}>{note?.text ?? ui("Its full path on the computer DSH runs on. DSH opens it as a workspace.")}</small>
  </div>;
}

/** One repository: a line that says what it is, and everything about it once opened. */
function Repo({ route, projects, startOpen, onChange, onProjects, onRemove }: {
  route: Route; projects: readonly Project[]; startOpen: boolean;
  onChange(change: (route: Route) => Route): void; onProjects(next: Project[]): void; onRemove(): void;
}) {
  const [open, setOpen] = useState(startOpen), [typing, setTyping] = useState(false), [branches, setBranches] = useState<Branches>();
  /** The project just chosen by hand: its default branch is filled in when the repository has none yet. */
  const fill = useRef<string>();
  const set = <K extends keyof Route>(name: K, value: Route[K]) => onChange(current => ({ ...current, [name]: value }));
  const project = projects.find(entry => entry.path === route.project);
  const choose = (path: string, list: readonly Project[] = projects) => {
    fill.current = path;
    onChange(current => ({ ...current, project: path, name: current.name || list.find(entry => entry.path === path)?.title || '' }));
  };
  useEffect(() => {
    const path = route.project;
    if (!open || !path || branches?.path === path) return;
    let alive = true;
    setBranches(undefined);
    call<{ defaultBase: string | null; branches: string[] }>('project', { path, globs: [] }).then(reply => {
      if (!alive) return;
      setBranches({ path, names: reply.branches ?? [] });
      if (fill.current === path && reply.defaultBase) onChange(current => current.project === path && !current.defaultBranch ? { ...current, defaultBranch: reply.defaultBase! } : current);
    }, () => { if (alive) setBranches({ path, names: [], failed: true }); });
    return () => { alive = false; };
  }, [open, route.project]);

  const where = project ? `${project.title} · ${machineOf(project)}` : route.project;
  const more = route.packageGlobs.length + route.sharedPaths.length > 0 || (route.pushRemote || 'origin') !== 'origin';
  const branchOptions = [{ value: '', label: ui("None: choose for each bug") }, ...[...new Set([...(route.defaultBranch ? [route.defaultBranch] : []), ...(branches?.names ?? [])])].map(name => ({ value: name, label: name }))];
  return <div className="tp-repo" data-open={open || undefined}>
    <button type="button" className="tp-repo-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Chevron />
      <span className="tp-repo-name">{route.name || ui("New repository")}</span>
      <span className="tp-repo-meta">{[where, route.defaultBranch].filter(Boolean).join(' · ')}</span>
      {!route.project ? <span className="tp-badge" data-warn>{ui("No project yet")}</span>
        : <span className="tp-badge">{route.accept === 'push-branch' ? ui("Pushes the branch") : ui("Merges and pushes")}</span>}
    </button>
    {open && <div className="tp-repo-body">
      <Row title={ui("Project")} hint={<>{ui("The Git repository, as a workspace DSH has open.")} <button type="button" className="tp-link" aria-expanded={typing} onClick={() => setTyping(value => !value)}>{ui("Not in the list?")}</button></>}>
        <Pick label={ui("Project")} value={route.project} placeholder={ui("Choose a project…")} onChange={path => choose(path)}
          options={[...(!project && route.project ? [{ value: route.project, label: route.project }] : []), ...projects.map(entry => ({ value: entry.path, label: `${entry.title} · ${machineOf(entry)}` }))]} />
      </Row>
      {typing && <FolderBox onAdded={(path, list) => { onProjects(list); choose(path, list); }} />}
      <Row title={ui("Name")} hint={ui("What the board calls this repository.")}>
        <input aria-label={ui("Name")} value={route.name} onChange={event => set('name', event.target.value)} /></Row>
      <Row title={ui("Default branch")} hint={ui("A fix starts from this branch, and goes back into it once accepted.")}>
        {branches?.failed || !route.project
          ? <input aria-label={ui("Default branch")} value={route.defaultBranch} placeholder="main" spellCheck={false} onChange={event => set('defaultBranch', event.target.value)} />
          : <Pick label={ui("Default branch")} value={route.defaultBranch} disabled={!branches} placeholder={branches ? ui("None: choose for each bug") : ui("Reading the branches…")} options={branchOptions} onChange={name => set('defaultBranch', name)} />}
      </Row>
      <Row title={ui("When a fix is accepted")} hint={route.accept === 'push-branch' ? ui("The fix's branch is pushed; the base branch stays as it is.") : ui("The fix is merged into the base branch, and that is pushed.")}>
        <Pick label={ui("When a fix is accepted")} value={route.accept} onChange={value => set('accept', value === 'push-branch' ? 'push-branch' : 'merge')}
          options={[{ value: 'merge', label: ui("Merge and push") }, { value: 'push-branch', label: ui("Only push the fix's branch") }]} />
      </Row>
      <Row stacked title={ui("Checks before committing")} hint={ui("One command per line; a fix is committed only if all of them pass. Leave empty to commit without checks.")}>
        <LinesInput label={ui("Checks before committing")} value={route.tests} placeholder={'pnpm install --frozen-lockfile\npnpm test'} onChange={next => set('tests', next)} /></Row>
      <details className="tp-more" open={more || undefined}>
        <summary><Chevron />{ui("Several packages, and the remote")}</summary>
        <Row stacked title={ui("Package folders")} hint={ui("For a repository of several packages, such as packages/*. In the checks, {package} and {script} then run a line once for each package the fix touched.")}>
          <Chips label={ui("Package folders")} value={route.packageGlobs} placeholder="packages/*" onChange={next => set('packageGlobs', next)} /></Row>
        <Row stacked title={ui("Shared paths")} hint={ui("Folders any fix may touch without counting as another package.")}>
          <Chips label={ui("Shared paths")} value={route.sharedPaths} placeholder="packages/components" onChange={next => set('sharedPaths', next)} /></Row>
        <Row stacked title={ui("Build scripts")} hint={ui("The first one a package has is its {script}.")}>
          <Chips label={ui("Build scripts")} value={route.buildScripts} placeholder="build" onChange={next => set('buildScripts', next)} /></Row>
        <Row title={ui("Remote")} hint={ui("Where accepted fixes are pushed.")}>
          <input aria-label={ui("Remote")} value={route.pushRemote} placeholder="origin" spellCheck={false} onChange={event => set('pushRemote', event.target.value)} /></Row>
      </details>
      <div className="tp-repo-foot"><button type="button" className="tp-button" data-danger onClick={onRemove}>{ui("Remove this repository")}</button></div>
    </div>}
  </div>;
}

/** Settings → Autofix: the repositories bugs can go to, and how tasks run. Each source of bugs has settings of its own. */
export function AutofixSettings({ board }: { board(): void }) {
  useLocale();
  const [form, setForm] = useState<Form>(), [sources, setSources] = useState<State['sources']>([]), [projects, setProjects] = useState<Project[]>([]), [relay, setRelay] = useState<State['relay']>([]);
  // Each repository card keeps its own state; a number that stays with it tells React which is which when one is removed.
  const [cards, setCards] = useState<{ id: number; fresh: boolean }[]>([]), nextCard = useRef(1);
  const [message, setMessage] = useState<Note>(), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false);
  const show = (settings: Form) => { setForm(settings); setCards(settings.routes.map(() => ({ id: nextCard.current++, fresh: false }))); setDirty(false); };
  const load = () => call('state').then(reply => { if (reply.state) { show(reply.state.settings); setSources(reply.state.sources); setRelay(reply.state.relay ?? []); } }, reason => setMessage({ kind: 'error', text: told(reason) }));
  useEffect(() => {
    void load();
    call<{ projects: Project[] }>('projects').then(reply => setProjects(reply.projects ?? []), () => undefined);
  }, []);
  useEffect(() => {
    if (message?.kind !== 'ok') return;
    const timer = setTimeout(() => setMessage(undefined), 2500);
    return () => clearTimeout(timer);
  }, [message]);
  if (!form) return <section className="tp-settings"><header className="tp-head"><h2>{ui("Autofix")}</h2></header>{message ? <p className="tp-error">{message.text}</p> : <p className="tp-muted">{ui("Loading…")}</p>}</section>;

  const change = (next: (form: Form) => Form) => { setForm(current => current && next(current)); setDirty(true); setMessage(undefined); };
  const run = <K extends keyof Settings['run']>(name: K, value: Settings['run'][K]) => change(current => ({ ...current, run: { ...current.run, [name]: value } }));
  const add = () => { change(current => ({ ...current, routes: [...current.routes, emptyRoute()] })); setCards(current => [...current, { id: nextCard.current++, fresh: true }]); };
  const remove = (index: number) => { change(current => ({ ...current, routes: current.routes.filter((_, at) => at !== index) })); setCards(current => current.filter((_, at) => at !== index)); };
  const save = async () => {
    setSaving(true);
    try {
      const reply = await call('saveSettings', { settings: form });
      if (reply.state) { setForm(reply.state.settings); setRelay(reply.state.relay ?? []); }
      setDirty(false); setMessage({ kind: 'ok', text: ui("Saved") });
    } catch (reason) { setMessage({ kind: 'error', text: told(reason) }); }
    finally { setSaving(false); }
  };
  const sourceSays = (source: State['sources'][number]) => source.id === 'manual' ? ui("with New bug on the board, pictures included") : source.unready ? ui(source.unready.key, source.unready.values) : source.fetches ? ui("fetched from the board") : ui("hands bugs in by itself");

  return <section className="tp-settings" aria-label={ui("Autofix")}>
    <header className="tp-head"><h2>{ui("Autofix")}</h2><button type="button" className="tp-button" onClick={board}>{ui("Open the board")}</button></header>
    <p className="tp-muted">{ui("Bugs fixed by models, each in its own worktree. Nothing is pushed before you accept it.")}</p>
    <p className="tp-tip">{ui("In any conversation of the project, type /fix and what is wrong; screenshots can be pasted along. The fix is then reviewed in its own conversation.")}</p>

    <h3>{ui("Repositories")}</h3>
    <p className="tp-muted">{ui("Where bugs can be sent. Each bug is fixed in a new worktree of its repository.")}</p>
    {form.routes.length === 0 && <div className="tp-empty">{ui("No repository yet. Add one so bugs have somewhere to go.")}</div>}
    {form.routes.map((route, index) => <Repo key={cards[index]?.id ?? index} route={route} projects={projects} startOpen={cards[index]?.fresh ?? false} onProjects={setProjects}
      onChange={next => change(current => ({ ...current, routes: current.routes.map((entry, at) => at === index ? next(entry) : entry) }))} onRemove={() => remove(index)} />)}
    <button type="button" className="tp-button tp-add" onClick={add}><span aria-hidden="true">+</span>{ui("Add a repository")}</button>

    <h3>{ui("How tasks run")}</h3>
    <p className="tp-muted">{ui("Each task plans, implements and reviews with the models chosen in Settings → Model flow.")}</p>
    <div className="tp-rows">
      <Row title={ui("What the models may do")} hint={ui("Nobody is there to answer a permission prompt.")}>
        <Pick label={ui("What the models may do")} value={form.run.permission} onChange={value => run('permission', value as Settings['run']['permission'])}
          options={[{ value: 'workspace-write', label: ui("Write in the workspace") }, { value: 'auto', label: ui("Auto") }, { value: 'danger-full-access', label: ui("Full access") }]} /></Row>
      <Row title={ui("Review rounds")} hint={ui("How many times a review may send the fix back.")}>
        <Stepper label={ui("Review rounds")} min={1} max={5} value={form.run.rounds} onChange={next => run('rounds', next)} /></Row>
      <Row title={ui("Send failed checks back")} hint={ui("How many times before the task fails.")}>
        <Stepper label={ui("Send failed checks back")} min={0} max={5} value={form.run.checkRetries} onChange={next => run('checkRetries', next)} /></Row>
      <Row title={ui("Take bugs from other DSHes")} hint={ui("For when you type /fix in another DSH, such as the one on your laptop: the bug is handed over through the machine that holds the repository, and this DSH runs the fix.")}>
        <button type="button" className="tp-switch" role="switch" aria-checked={form.run.relay} aria-label={ui("Take bugs from other DSHes")} onClick={() => run('relay', !form.run.relay)} /></Row>
      {form.run.relay && relay.length > 0 && <ul className="tp-relay">{relay.map((entry, index) => <li key={index} data-error={entry.error ? true : undefined}>
        <i aria-hidden="true" />{entry.error ? ui("{0}: not reachable", { 0: entry.label }) : ui("{0}: taking bugs for {1}", { 0: entry.label === 'this computer' ? ui("this computer") : entry.label, 1: entry.routes.join(', ') })}{entry.error && <small>{entry.error}</small>}</li>)}</ul>}
      <Row stacked title={ui("Never hand these labels to models")} hint={ui("A bug with one of these labels waits for a person.")}>
        <Chips label={ui("Never hand these labels to models")} value={form.run.denyLabels} placeholder="security" onChange={next => run('denyLabels', next)} /></Row>
    </div>

    <h3>{ui("Where bugs come from")}</h3>
    <div className="tp-rows">
      {sources.map(source => <div key={source.id} className="tp-row">
        <div className="tp-row-text"><span>{source.id === 'manual' ? ui("Typed in") : source.name}</span><small>{sourceSays(source)}</small></div>
        <span className="tp-status" data-ready={!source.unready || undefined}><i aria-hidden="true" />{source.unready ? ui("Needs setting up") : ui("Ready")}</span>
      </div>)}
    </div>
    <p className="tp-muted">{ui("Every other source is a plugin with settings of its own, such as dsh-tapd.")}</p>

    {(dirty || saving || message) && <footer className="tp-savebar" data-kind={message?.kind}>
      <span role={message?.kind === 'error' ? 'alert' : 'status'}>{message?.text ?? ui("Unsaved changes")}</span>
      {dirty && <>
        <button type="button" className="tp-button" disabled={saving} onClick={() => { setMessage(undefined); void load(); }}>{ui("Discard")}</button>
        <button type="button" className="tp-button" data-primary disabled={saving} onClick={() => void save()}>{saving ? ui("Saving…") : ui("Save")}</button>
      </>}
    </footer>}
  </section>;
}
