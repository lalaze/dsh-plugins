import React, { useEffect, useState } from 'react';
import { PROVIDER_LABELS, type Choice } from '../../core/domain.js';
import { membersWithoutWork, modelsNamed, sameName, taskOrder, type PresetMember, type PresetTask, type TeamPreset } from '../../teams/presets.js';
import { api } from '../api.js';
import { localizeError, ui } from '../i18n.js';
import { Chevron } from './menu.js';

interface CatalogModel { id: string; label: string; isDefault?: boolean; thinkingOptions?: Choice[]; defaultThinkingOptionId?: string }
interface HostModels { id: string; label: string; providers: { id: string; label: string; models: CatalogModel[] }[] }
interface Presets { presets: TeamPreset[]; builtin: TeamPreset[]; hosts: HostModels[] }
const CAPTAIN = '';
const EXAMPLE = '/team pair coder=codex@high reviewer=claude/opus ';

/** What a member runs on: `Codex gpt-5 (high)`. */
function routeOf(member: PresetMember): string {
  if (!member.cli) return ui('Captain’s model');
  return `${PROVIDER_LABELS[member.cli] ?? member.cli} ${member.model || ui('default model')}${member.effort ? ` (${member.effort})` : ''}`;
}
/** The tasks in the order they run: `work (coder) → review (reviewer)`. */
function flowLine(tasks: PresetTask[]): string {
  return taskOrder(tasks).steps.map(step => step.map(task => task.assignee ? `${task.id} (${task.assignee})` : task.id).join(' + ')).join(' → ');
}
/** The models every machine's CLI lists, deduplicated by id, as the editor's choices. */
function modelsOf(hosts: HostModels[], cli: string | undefined) {
  const models = new Map<string, CatalogModel>();
  if (cli) for (const host of hosts) for (const provider of host.providers) if (provider.id === cli) for (const model of provider.models) if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}
/** The model a member ends up on, as `/team` finds it: the one named, else the CLI's default. */
function resolvedModel(models: CatalogModel[], name: string | undefined): CatalogModel | undefined {
  if (!name) return models.find(model => model.isDefault) ?? models[0];
  const named = modelsNamed(models, name);
  return named.length === 1 ? named[0] : undefined;
}
const levelNamed = (levels: Choice[], name: string | undefined) => name ? levels.find(level => sameName(level.id, name) || sameName(level.label, name)) : undefined;
function MemberRow({ member, hosts, members, change, remove, disabled, defaultOpen }: { member: PresetMember; hosts: HostModels[]; members: PresetMember[]; change(next: PresetMember): void; remove(): void; disabled: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const models = modelsOf(hosts, member.cli), model = resolvedModel(models, member.model), standard = resolvedModel(models, undefined);
  const levels = model?.thinkingOptions ?? [], level = levelNamed(levels, member.effort), standardLevel = levels.find(option => option.id === model?.defaultThinkingOptionId);
  const set = (patch: Partial<PresetMember>) => change(Object.fromEntries(Object.entries({ ...member, ...patch }).filter(([, value]) => value !== undefined && value !== '')) as unknown as PresetMember);
  // A thinking level belongs to its model: it stays only if the new model has it too.
  const chooseModel = (id: string) => set({ model: id, effort: levelNamed(resolvedModel(models, id || undefined)?.thinkingOptions ?? [], member.effort) ? member.effort : undefined });
  return <article className="ra-team-card ra-team-card-member" data-open={open}>
    <div className="ra-team-card-head">
      <button type="button" className="ra-team-card-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><Chevron open={open} /><strong>{member.name || ui('New member')}</strong><span className="ra-muted">{routeOf(member)}</span></button>
      <button type="button" className="ra-danger ra-team-card-remove" disabled={disabled || members.length <= 1} onClick={remove} aria-label={ui('Remove member')}>×</button>
    </div>
    {open && <div className="ra-team-fields ra-team-member-fields">
      <label className="ra-field">{ui('Member')}<input required maxLength={40} value={member.name ?? ''} onChange={event => set({ name: event.target.value.trim() })} placeholder="coder" /></label>
      <label className="ra-field">{ui('Role')}<input maxLength={100} value={member.role ?? ''} onChange={event => set({ role: event.target.value })} placeholder={ui('implement')} /></label>
      <label className="ra-field">{ui('CLI')}<select value={member.cli ?? CAPTAIN} onChange={event => set({ cli: event.target.value || undefined, model: undefined, effort: undefined })}>
        <option value={CAPTAIN}>{ui('Captain’s model')}</option>{Object.entries(PROVIDER_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="ra-field">{ui('Model')}{models.length ? <select value={member.model ? model?.id ?? member.model : ''} onChange={event => chooseModel(event.target.value)}>
        <option value="">{standard ? ui('Default ({choice})', { choice: standard.label }) : ui('default model')}</option>
        {member.model && !model && <option value={member.model}>{ui('{choice} (not listed)', { choice: member.model })}</option>}
        {models.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        : <input maxLength={200} disabled={!member.cli} value={member.model ?? ''} onChange={event => set({ model: event.target.value })} placeholder={member.cli ? ui('default model') : ''} />}</label>
      <label className="ra-field">{ui('Thinking')}{model ? <select disabled={!levels.length && !member.effort} value={member.effort ? level?.id ?? member.effort : ''} onChange={event => set({ effort: event.target.value || undefined })}>
        <option value="">{!levels.length ? ui('Not supported') : standardLevel ? ui('Default ({choice})', { choice: standardLevel.label }) : ui('default')}</option>
        {member.effort && !level && <option value={member.effort}>{ui('{choice} (not listed)', { choice: member.effort })}</option>}
        {levels.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        : <input maxLength={50} disabled={!member.cli} value={member.effort ?? ''} onChange={event => set({ effort: event.target.value })} placeholder={member.cli ? ui('default') : ''} />}</label>
      {member.cli && !models.length && <p className="ra-muted ra-team-field-note">{ui('No machine lists {cli}’s models yet, so type a model id, or leave it empty for the default.', { cli: PROVIDER_LABELS[member.cli] ?? member.cli })}</p>}
    </div>}
  </article>;
}
function TaskRow({ task, tasks, members, change, remove, disabled, defaultOpen }: { task: PresetTask; tasks: PresetTask[]; members: PresetMember[]; change(next: PresetTask): void; remove(): void; disabled: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const others = tasks.filter(other => other.id !== task.id && other.id), dependencies = task.dependencies ?? [];
  const set = (patch: Partial<PresetTask>) => change(Object.fromEntries(Object.entries({ ...task, ...patch }).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && !value.length))) as unknown as PresetTask);
  const summary = `→ ${task.assignee || ui('any idle member')}${dependencies.length ? ` · ${ui('waits for {tasks}', { tasks: dependencies.join(', ') })}` : ''}`;
  return <article className="ra-team-card ra-team-card-task" data-open={open}>
    <div className="ra-team-card-head">
      <button type="button" className="ra-team-card-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><Chevron open={open} /><strong>{task.id || ui('New task')}</strong><span className="ra-muted">{summary}</span></button>
      <button type="button" className="ra-danger ra-team-card-remove" disabled={disabled} onClick={remove} aria-label={ui('Remove task')}>×</button>
    </div>
    {open && <div className="ra-team-fields ra-team-task-fields">
      <label className="ra-field">{ui('Task id')}<input required maxLength={32} value={task.id ?? ''} onChange={event => set({ id: event.target.value.trim() })} placeholder="work" /></label>
      <label className="ra-field">{ui('Assignee')}<select value={task.assignee ?? ''} onChange={event => set({ assignee: event.target.value || undefined })}><option value="">{ui('any idle member')}</option>{members.filter(member => member.name).map(member => <option key={member.name} value={member.name}>{member.name}</option>)}</select></label>
      <label className="ra-field ra-team-subject">{ui('Subject')}<input required maxLength={500} value={task.subject ?? ''} onChange={event => set({ subject: event.target.value })} placeholder="{goal}" /></label>
      <label className="ra-field ra-team-description">{ui('Instructions')}<textarea rows={2} maxLength={4000} value={task.description ?? ''} onChange={event => set({ description: event.target.value })} placeholder={ui('What the member does; {goal} stands for the goal typed after /team.')} /></label>
      <fieldset className="ra-team-deps" disabled={disabled}><legend>{ui('Starts after')}</legend>{others.length ? others.map(other => <label key={other.id}><input type="checkbox" checked={dependencies.includes(other.id)} onChange={event => set({ dependencies: event.target.checked ? [...dependencies, other.id] : dependencies.filter(id => id !== other.id) })} />{other.id}</label>) : <span className="ra-muted">{ui('No other tasks')}</span>}</fieldset>
    </div>}
  </article>;
}
/** What the preset does once started, worked out from the members and tasks as they stand, and what would go wrong. */
function TeamFlow({ preset, addTask, disabled }: { preset: TeamPreset; addTask(assignee: string): void; disabled: boolean }) {
  const { steps, stuck } = taskOrder(preset.tasks), memberOf = (name: string | undefined) => preset.members.find(member => member.name === name);
  return <div className="ra-team-flow">
    <code className="ra-team-line">/team {preset.id || ui('preset-id')} {ui('your goal')}</code>
    {preset.tasks.length > 0 && <ol className="ra-team-flow-steps">
      {steps.map((tasks, index) => <li key={index}>
        <span className="ra-team-flow-at">{tasks.length > 1 ? ui('Step {step}, together', { step: index + 1 }) : ui('Step {step}', { step: index + 1 })}</span>
        <div className="ra-team-flow-tasks">{tasks.map(task => { const member = memberOf(task.assignee); return <div key={task.id}>
          <strong>{task.id || ui('New task')}</strong><span>{member ? `${member.name} · ${routeOf(member)}` : ui('any idle member')}</span>
          {!!task.dependencies?.length && <span className="ra-muted">{ui('waits for {tasks}', { tasks: task.dependencies.join(', ') })}</span>}
        </div>; })}</div>
      </li>)}
      <li><span className="ra-team-flow-at">{ui('Finally')}</span><div className="ra-team-flow-tasks ra-muted">{ui('Each member reports to the conversation that typed /team, which leads the team as its captain.')}</div></li>
    </ol>}
    {!preset.tasks.length && <div className="ra-banner" role="status">{ui('No tasks yet: the team would have nothing to do.')}</div>}
    {stuck.length > 0 && <div className="ra-banner" data-tone="error" role="alert">{ui('{tasks} wait on each other and can never start. Uncheck one under Starts after.', { tasks: stuck.map(task => task.id).join(', ') })}</div>}
    {membersWithoutWork(preset).map(member => <div className="ra-banner" role="status" key={member.name}>{ui('{member} has no task and will never start.', { member: member.name })}
      <button type="button" disabled={disabled} onClick={() => addTask(member.name)}>{ui('Add a task for {member}', { member: member.name })}</button></div>)}
  </div>;
}
const withDependencies = ({ dependencies: _, ...task }: PresetTask, ids: string[]): PresetTask => ids.length ? { ...task, dependencies: ids } : task;
function PresetEditor({ initial, saved, hosts, cancel, save, busy, error }: { initial: TeamPreset; saved: boolean; hosts: HostModels[]; cancel(): void; save(preset: TeamPreset): void; busy: boolean; error: string }) {
  const [preset, setPreset] = useState(initial);
  // A saved preset opens with every row collapsed; a new preset or a just-added row opens expanded.
  const [openMember, setOpenMember] = useState(-1), [openTask, setOpenTask] = useState(-1);
  const members = preset.members, tasks = preset.tasks;
  const update = (patch: Partial<TeamPreset>) => setPreset(current => ({ ...current, ...patch }));
  // A member rename or removal follows through to the tasks assigned to that member, so the roster and the DAG never disagree.
  const changeMember = (index: number, next: PresetMember) => setPreset(current => {
    const previous = current.members[index];
    const tasks = previous.name && previous.name !== next.name ? current.tasks.map(task => task.assignee === previous.name ? { ...task, assignee: next.name || undefined } : task) : current.tasks;
    return { ...current, members: current.members.map((member, at) => at === index ? next : member), tasks };
  });
  const removeMember = (index: number) => setPreset(current => {
    const removed = current.members[index];
    return { ...current, members: current.members.filter((_, at) => at !== index), tasks: current.tasks.map(task => task.assignee === removed.name ? { ...task, assignee: undefined } : task) };
  });
  // So does a task's, for the tasks waiting on it: a dependency on a task that is gone has no checkbox left to clear it with.
  const changeTask = (index: number, next: PresetTask) => setPreset(current => {
    const previous = current.tasks[index].id;
    return { ...current, tasks: current.tasks.map((task, at) => at === index ? next : previous !== next.id && task.dependencies?.includes(previous) ? withDependencies(task, task.dependencies.map(id => id === previous ? next.id : id).filter(Boolean)) : task) };
  });
  const removeTask = (index: number) => setPreset(current => {
    const removed = current.tasks[index].id;
    return { ...current, tasks: current.tasks.filter((_, at) => at !== index).map(task => task.dependencies?.includes(removed) ? withDependencies(task, task.dependencies.filter(id => id !== removed)) : task) };
  });
  const addTask = (assignee?: string) => {
    let number = tasks.length + 1;
    while (tasks.some(task => task.id === `t${number}`)) number++;
    setOpenTask(tasks.length);
    // A member with no work yet is the likely reason for another task.
    update({ tasks: [...tasks, { id: `t${number}`, subject: '{goal}', assignee: (assignee ?? membersWithoutWork(preset)[0]?.name ?? members[0]?.name) || undefined }] });
  };
  return <form className="ra-host-form ra-team-form" onSubmit={event => { event.preventDefault(); save(preset); }}>
    <h3>{saved ? ui('Edit preset {id}', { id: initial.id }) : initial.id ? ui('Customize {id}', { id: initial.id }) : ui('New preset')}</h3>
    <div className="ra-grid">
      <label className="ra-field">{ui('Preset id (typed after /team)')}<input required disabled={saved} pattern="[a-z0-9][a-z0-9-]{0,31}" maxLength={32} value={preset.id} onChange={event => update({ id: event.target.value.toLowerCase() })} placeholder="pair" /></label>
      <label className="ra-field">{ui('Description')}<input maxLength={100} value={preset.label ?? ''} onChange={event => update({ label: event.target.value || undefined })} /></label>
    </div>
    <h4><span className="ra-team-number">1</span>{ui('Members: who does the work')}</h4>
    <p className="ra-muted">{ui('A member runs its CLI on the machine of the conversation’s remote workspace. The captain’s model is the one the conversation that typed /team is using.')}</p>
    {members.map((member, index) => <MemberRow key={index} member={member} hosts={hosts} members={members} disabled={busy} defaultOpen={!saved || index === openMember}
      change={next => changeMember(index, next)} remove={() => removeMember(index)} />)}
    <div className="ra-actions"><button type="button" disabled={busy || members.length >= 8} onClick={() => { setOpenMember(members.length); update({ members: [...members, { name: '' }] }); }}>{ui('Add member')}</button></div>
    <h4><span className="ra-team-number">2</span>{ui('Tasks: what gets done, in what order')}</h4>
    <p className="ra-muted">{ui('Give each task to a member. A task starts with the team unless it waits for others, and a member does one task at a time. {goal} becomes the goal typed after /team, which every member can read.')}</p>
    {tasks.map((task, index) => <TaskRow key={index} task={task} tasks={tasks} members={members} disabled={busy} defaultOpen={!saved || index === openTask}
      change={next => changeTask(index, next)} remove={() => removeTask(index)} />)}
    <div className="ra-actions"><button type="button" disabled={busy || tasks.length >= 32} onClick={() => addTask()}>{ui('Add task')}</button></div>
    <h4><span className="ra-team-number">3</span>{ui('How it will run')}</h4>
    <TeamFlow preset={preset} addTask={addTask} disabled={busy || tasks.length >= 32} />
    {error && <div className="ra-banner ra-team-save-error" data-tone="error" role="alert">{localizeError(error)}</div>}
    <div className="ra-actions ra-team-save"><button type="button" disabled={busy} onClick={cancel}>{ui('Cancel')}</button><button className="ra-primary" disabled={busy || !tasks.length}>{ui(busy ? 'Saving…' : 'Save preset')}</button></div>
  </form>;
}

/** The `/team` presets: who the members are, which CLIs they run and the tasks they start with. */
export function TeamPresets() {
  const [data, setData] = useState<Presets>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ preset: TeamPreset; saved: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    void api<Presets>('teamPresets', {}, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); },
      e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, []);
  const run = async (action: () => Promise<Presets>) => {
    setBusy(true); setError('');
    try { setData(await action()); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };
  const saved = data?.presets ?? [], builtin = (data?.builtin ?? []).filter(preset => !saved.some(own => own.id === preset.id));
  return <div className="ra-page ra-teams">
    <h2>{ui('Team presets')}</h2>
    <p className="ra-muted">{ui('Split one goal across several remote CLIs: each member does its tasks and reports back to the conversation. Needs NanmiCoder’s dsh-agent-teams plugin.')}</p>
    <ol className="ra-team-howto">
      <li>{ui('Pick a preset below or make one: who works, on what, in what order.')}</li>
      <li>{ui('In a conversation of a remote workspace, type one line:')}<code className="ra-team-line">/team {saved[0]?.id ?? 'pair'} {ui('fix the login timeout')}</code></li>
      <li>{ui('Tasks start at once, with no plan to approve. The team panel opens beside the conversation to show progress, and members report back to the conversation.')}</li>
    </ol>
    <details className="ra-team-syntax"><summary>{ui('Full command')}</summary>
      <pre className="ra-team-usage"><code>{`/team [preset] [member=cli/model@thinking] [--plan] goal\n${EXAMPLE}${ui('fix the login timeout')}`}</code></pre>
      <p className="ra-muted">{ui('member=… changes a member for this run only. Without a preset name, the first saved preset whose members match the assignments is used, else solo or pair. --plan stages the plan for review in the team panel instead of starting.')}</p>
    </details>
    {error && !(data && editing) && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}</div>}
    {!data ? !error && <div className="ra-empty" role="status">{ui('Loading…')}</div> : <>
      <ul className="ra-host-list ra-team-list" aria-label={ui('Team presets')}>{[...saved.map(preset => ({ preset, saved: true })), ...builtin.map(preset => ({ preset, saved: false }))].map(({ preset, saved: own }, index) => <li className="ra-host-row" key={preset.id}>
        <div className="ra-host-name"><div className="ra-host-title"><strong>{preset.id}</strong>{preset.label && <span className="ra-muted">{preset.label}</span>}
          {own && index === 0 && <span className="ra-badge">{ui('Default')}</span>}{!own && <span className="ra-badge">{ui('Built in')}</span>}</div>
          <span className="ra-muted">{preset.members.map(member => `${member.name} → ${routeOf(member)}`).join(' · ')}</span>
          <span className="ra-muted">{flowLine(preset.tasks)}</span>
          <code className="ra-team-line">/team {preset.id} {ui('your goal')}</code></div>
        <button type="button" disabled={busy} onClick={() => setEditing({ preset: structuredClone(preset), saved: own })}>{ui(own ? 'Edit' : 'Customize')}</button>
        {own && index > 0 && <button type="button" disabled={busy} onClick={() => void run(() => api<Presets>('saveTeamPreset', { preset, first: true }))}>{ui('Make default')}</button>}
        {own && <button type="button" className="ra-danger" disabled={busy} onClick={() => void run(() => api<Presets>('removeTeamPreset', { presetId: preset.id }))}>{ui('Remove')}</button>}
      </li>)}</ul>
      {editing ? <PresetEditor key={editing.preset.id} initial={editing.preset} saved={editing.saved} hosts={data.hosts} busy={busy} error={error} cancel={() => { setEditing(undefined); setError(''); }}
        save={preset => void run(() => api<Presets>('saveTeamPreset', { preset })).then(ok => { if (ok) setEditing(undefined); })} />
        : <div className="ra-actions"><button type="button" disabled={busy} onClick={() => setEditing({ preset: { id: '', members: [{ name: 'coder', role: 'implement', cli: 'codex' }], tasks: [{ id: 'work', subject: '{goal}', assignee: 'coder' }] }, saved: false })}>{ui('New preset')}</button></div>}
    </>}
  </div>;
}
