import React, { useEffect, useId, useState } from 'react';
import { PROVIDER_LABELS, type Choice } from '../../core/domain.js';
import type { PresetMember, PresetTask, TeamPreset } from '../../teams/presets.js';
import { api } from '../api.js';
import { localizeError, ui } from '../i18n.js';

interface HostModels { id: string; label: string; providers: { id: string; label: string; models: { id: string; label: string; isDefault?: boolean; thinkingOptions?: Choice[] }[] }[] }
interface Presets { presets: TeamPreset[]; builtin: TeamPreset[]; hosts: HostModels[] }
const CAPTAIN = '';
const EXAMPLE = '/team pair coder=codex reviewer=claude/opus ';

function memberSummary(member: PresetMember): string {
  if (!member.cli) return ui('{member} → the captain’s model', { member: member.name });
  return `${member.name} → ${PROVIDER_LABELS[member.cli] ?? member.cli}${member.model ? ` ${member.model}` : ''}${member.effort ? ` (${member.effort})` : ''}`;
}
/** The models every machine's CLI lists, deduplicated by id, as the editor's suggestions. */
function modelsOf(hosts: HostModels[], cli: string | undefined) {
  const models = new Map<string, { id: string; label: string; thinkingOptions?: Choice[] }>();
  if (cli) for (const host of hosts) for (const provider of host.providers) if (provider.id === cli) for (const model of provider.models) if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}
function MemberRow({ member, hosts, members, change, remove, disabled }: { member: PresetMember; hosts: HostModels[]; members: PresetMember[]; change(next: PresetMember): void; remove(): void; disabled: boolean }) {
  const list = useId(), models = modelsOf(hosts, member.cli), known = models.find(model => model.id === member.model), levels = known?.thinkingOptions ?? [];
  const set = (patch: Partial<PresetMember>) => change(Object.fromEntries(Object.entries({ ...member, ...patch }).filter(([, value]) => value !== undefined && value !== '')) as unknown as PresetMember);
  return <div className="ra-team-row ra-team-member">
    <label className="ra-field">{ui('Member')}<input required maxLength={40} value={member.name ?? ''} onChange={event => set({ name: event.target.value.trim() })} placeholder="coder" /></label>
    <label className="ra-field">{ui('Role')}<input maxLength={100} value={member.role ?? ''} onChange={event => set({ role: event.target.value })} placeholder={ui('implement')} /></label>
    <label className="ra-field">{ui('CLI')}<select value={member.cli ?? CAPTAIN} onChange={event => set({ cli: event.target.value || undefined, model: undefined, effort: undefined })}>
      <option value={CAPTAIN}>{ui('Captain’s model')}</option>{Object.entries(PROVIDER_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="ra-field">{ui('Model')}<input list={list} maxLength={200} disabled={!member.cli} value={member.model ?? ''} onChange={event => set({ model: event.target.value, effort: undefined })} placeholder={member.cli ? ui('default model') : ''} />
      <datalist id={list}>{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist></label>
    <label className="ra-field">{ui('Thinking')}{levels.length ? <select value={member.effort ?? ''} onChange={event => set({ effort: event.target.value || undefined })}><option value="">{ui('default')}</option>{levels.map(level => <option key={level.id} value={level.id}>{level.label}</option>)}</select>
      : <input maxLength={50} disabled={!member.cli} value={member.effort ?? ''} onChange={event => set({ effort: event.target.value })} placeholder={ui('default')} />}</label>
    <button type="button" className="ra-danger" disabled={disabled || members.length <= 1} onClick={remove} aria-label={ui('Remove member')}>×</button>
  </div>;
}
function TaskRow({ task, tasks, members, change, remove, disabled }: { task: PresetTask; tasks: PresetTask[]; members: PresetMember[]; change(next: PresetTask): void; remove(): void; disabled: boolean }) {
  const others = tasks.filter(other => other.id !== task.id && other.id), dependencies = task.dependencies ?? [];
  const set = (patch: Partial<PresetTask>) => change(Object.fromEntries(Object.entries({ ...task, ...patch }).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && !value.length))) as unknown as PresetTask);
  return <div className="ra-team-row ra-team-task">
    <label className="ra-field">{ui('Task id')}<input required maxLength={32} value={task.id ?? ''} onChange={event => set({ id: event.target.value.trim() })} placeholder="work" /></label>
    <label className="ra-field ra-team-subject">{ui('Subject')}<input required maxLength={500} value={task.subject ?? ''} onChange={event => set({ subject: event.target.value })} placeholder="{goal}" /></label>
    <label className="ra-field">{ui('Assignee')}<select value={task.assignee ?? ''} onChange={event => set({ assignee: event.target.value || undefined })}><option value="">{ui('any idle member')}</option>{members.filter(member => member.name).map(member => <option key={member.name} value={member.name}>{member.name}</option>)}</select></label>
    <label className="ra-field ra-team-description">{ui('Instructions')}<textarea rows={2} maxLength={4000} value={task.description ?? ''} onChange={event => set({ description: event.target.value })} placeholder={ui('What the member does; {goal} stands for the goal typed after /team.')} /></label>
    <fieldset className="ra-team-deps" disabled={disabled}><legend>{ui('After')}</legend>{others.length ? others.map(other => <label key={other.id}><input type="checkbox" checked={dependencies.includes(other.id)} onChange={event => set({ dependencies: event.target.checked ? [...dependencies, other.id] : dependencies.filter(id => id !== other.id) })} />{other.id}</label>) : <span className="ra-muted">{ui('No other tasks')}</span>}</fieldset>
    <button type="button" className="ra-danger" disabled={disabled} onClick={remove} aria-label={ui('Remove task')}>×</button>
  </div>;
}
function PresetEditor({ initial, saved, hosts, cancel, save, busy }: { initial: TeamPreset; saved: boolean; hosts: HostModels[]; cancel(): void; save(preset: TeamPreset): void; busy: boolean }) {
  const [preset, setPreset] = useState(initial);
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
  return <form className="ra-host-form ra-team-form" onSubmit={event => { event.preventDefault(); save(preset); }}>
    <h3>{saved ? ui('Edit preset {id}', { id: initial.id }) : ui('New preset')}</h3>
    <div className="ra-grid">
      <label className="ra-field">{ui('Preset id (typed after /team)')}<input required disabled={saved} pattern="[a-z0-9][a-z0-9-]{0,31}" maxLength={32} value={preset.id} onChange={event => update({ id: event.target.value.toLowerCase() })} placeholder="pair" /></label>
      <label className="ra-field">{ui('Description')}<input maxLength={100} value={preset.label ?? ''} onChange={event => update({ label: event.target.value || undefined })} /></label>
    </div>
    <h4>{ui('Members')}</h4>
    <p className="ra-muted">{ui('A member’s CLI runs on the machine of the conversation’s remote workspace; the model is found there by id or name, the default model when empty. The line can still override a member: coder=claude/opus.')}</p>
    {members.map((member, index) => <MemberRow key={index} member={member} hosts={hosts} members={members} disabled={busy}
      change={next => changeMember(index, next)} remove={() => removeMember(index)} />)}
    <div className="ra-actions"><button type="button" disabled={busy || members.length >= 8} onClick={() => update({ members: [...members, { name: '' }] })}>{ui('Add member')}</button></div>
    <h4>{ui('Tasks')}</h4>
    <p className="ra-muted">{ui('Tasks start as soon as the team does; a task waits for the tasks it comes after. Every member reads the goal, so a task can simply say what its member contributes.')}</p>
    {tasks.map((task, index) => <TaskRow key={index} task={task} tasks={tasks} members={members} disabled={busy}
      change={next => update({ tasks: tasks.map((current, at) => at === index ? next : current) })} remove={() => update({ tasks: tasks.filter((_, at) => at !== index) })} />)}
    <div className="ra-actions"><button type="button" disabled={busy || tasks.length >= 32} onClick={() => update({ tasks: [...tasks, { id: `t${tasks.length + 1}`, subject: '{goal}', assignee: members[0]?.name }] })}>{ui('Add task')}</button></div>
    <div className="ra-actions ra-team-save"><button type="button" disabled={busy} onClick={cancel}>{ui('Cancel')}</button><button className="ra-primary" disabled={busy || !preset.id || !tasks.length}>{ui(busy ? 'Saving…' : 'Save preset')}</button></div>
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
    <p className="ra-muted">{ui('With NanmiCoder’s dsh-agent-teams installed, one line in a conversation starts a team whose members are remote CLIs on the workspace’s machine and runs it at once, without a planning turn or a plan to approve:')}</p>
    <pre className="ra-team-usage"><code>{`/team [preset] [member=cli/model] [--plan] goal\n${EXAMPLE}${ui('fix the login timeout')}`}</code></pre>
    <p className="ra-muted">{ui('Without a preset name, the first saved preset whose members match the assignments is used, else solo or pair. --plan stages the plan for review in the team panel instead of starting.')}</p>
    {error && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}</div>}
    {!data ? !error && <div className="ra-empty" role="status">{ui('Loading…')}</div> : <>
      <ul className="ra-host-list ra-team-list" aria-label={ui('Team presets')}>{[...saved.map(preset => ({ preset, saved: true })), ...builtin.map(preset => ({ preset, saved: false }))].map(({ preset, saved: own }, index) => <li className="ra-host-row" key={preset.id}>
        <div className="ra-host-name"><div className="ra-host-title"><strong>{preset.id}</strong>{preset.label && <span className="ra-muted">{preset.label}</span>}
          {own && index === 0 && <span className="ra-badge">{ui('Default')}</span>}{!own && <span className="ra-badge">{ui('Built in')}</span>}</div>
          <span className="ra-muted">{preset.members.map(memberSummary).join(' · ')}</span>
          <span className="ra-muted">{ui('{count} tasks: {tasks}', { count: preset.tasks.length, tasks: preset.tasks.map(task => task.assignee ? `${task.id} (${task.assignee})` : task.id).join(', ') })}</span></div>
        <button type="button" disabled={busy} onClick={() => setEditing({ preset: structuredClone(preset), saved: own })}>{ui(own ? 'Edit' : 'Customize')}</button>
        {own && index > 0 && <button type="button" disabled={busy} onClick={() => void run(() => api<Presets>('saveTeamPreset', { preset, first: true }))}>{ui('Make default')}</button>}
        {own && <button type="button" className="ra-danger" disabled={busy} onClick={() => void run(() => api<Presets>('removeTeamPreset', { presetId: preset.id }))}>{ui('Remove')}</button>}
      </li>)}</ul>
      {editing ? <PresetEditor key={editing.preset.id} initial={editing.preset} saved={editing.saved} hosts={data.hosts} busy={busy} cancel={() => setEditing(undefined)}
        save={preset => void run(() => api<Presets>('saveTeamPreset', { preset })).then(ok => { if (ok) setEditing(undefined); })} />
        : <div className="ra-actions"><button type="button" disabled={busy} onClick={() => setEditing({ preset: { id: '', members: [{ name: 'coder', role: 'implement', cli: 'codex' }], tasks: [{ id: 'work', subject: '{goal}', assignee: 'coder' }] }, saved: false })}>{ui('New preset')}</button></div>}
    </>}
  </div>;
}
