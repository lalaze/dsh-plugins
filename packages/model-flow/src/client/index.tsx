import type { LocaleContext } from '@dsh-plugins/i18n';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { comboName, MAX_COMBO_NAME, placeCombo, renameCombo, sameSetup, startersFor, type Combo, type Setup } from '../combos.js';
import { API_PATH, type EffortOption } from '../shared.js';
import { MAX_ROUNDS } from '../line.js';
import { machineOf, mainMachine, nameParts, nativeModel, type CatalogModel, type Role, type Route } from '../routes.js';
import type { FlowConfig } from '../store.js';
import { post } from './api.js';
import { extend, type FlowView, type ModelFlowCard, type ViewExtras } from './extend.js';
import { FlowCardView, FlowRow, flowRowStyles } from './flow-row.js';
import { i18n, ui, useLocale } from './i18n.js';
import { machineName, modelGroups, modelKey, preferredModel, routeKey } from './model-list.js';
import { Select, useEscape } from './select.js';

const styles = `
.mf-settings{container-type:inline-size;display:flex;flex-direction:column;gap:12px;font-size:13px}
.mf-settings h2{font-size:15px;font-weight:600;margin:0}
.mf-muted{color:var(--dsw-alias-label-secondary,#6b7280);margin:0;line-height:1.5}
.mf-row{display:grid;grid-template-columns:64px minmax(0,1fr) minmax(0,140px);gap:8px;align-items:center}
.mf-row>label,.mf-combos-title{font-weight:500}
.mf-trigger{display:flex;align-items:center;gap:6px;min-width:0;width:100%;height:30px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3,#d1d5db);border-radius:6px;background:transparent;color:inherit;padding:0 8px;font:inherit;text-align:left;cursor:pointer}
.mf-trigger:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-trigger:focus-visible,.mf-combo-apply:focus-visible,.mf-button:focus-visible,.mf-combo-remove:focus-visible,.mf-combo-rename:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#517ee8);outline-offset:1px}
.mf-trigger[aria-expanded=true]{border-color:var(--dsw-alias-brand-primary,#517ee8)}
.mf-trigger:disabled{color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:default}
.mf-trigger-text{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-tag{flex:0 2 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
.mf-warning{flex:none;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;font-size:10px;font-weight:600;line-height:14px;text-align:center}
.mf-chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary,#9ca3af);transition:transform .15s}
.mf-trigger[aria-expanded=true] .mf-chevron{transform:rotate(180deg)}
.mf-menu{position:fixed;inset:auto;margin:0;padding:0;box-sizing:border-box;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:10px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 32px #0004,0 2px 8px #0002;overflow:hidden;font-size:13px}
.mf-menu:popover-open{display:flex}
.mf-search{flex:none;display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#d1d5db);color:var(--dsw-alias-label-tertiary,#9ca3af)}
.mf-search input{flex:1;min-width:0;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit}
.mf-list{flex:1;min-height:0;padding:4px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.mf-option,.mf-group{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 8px;border-radius:6px;cursor:pointer;scroll-margin:32px 0 4px}
.mf-option[data-active=true],.mf-group[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-option-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-check{flex:none;color:var(--dsw-alias-brand-primary,#517ee8)}
.mf-choices{flex:0 1 auto;max-width:65%;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;padding:3px 0}
.mf-choice{height:20px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:11px;line-height:18px;cursor:pointer}
.mf-choice:hover,.mf-choice[data-active=true]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--dsw-alias-label-tertiary,#9ca3af)}
.mf-choice[aria-pressed=true]{color:var(--dsw-alias-brand-primary,#517ee8);border-color:currentColor}
.mf-group{position:sticky;top:-4px;z-index:1;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font-weight:500}
.mf-group[data-active=true]{box-shadow:inset 0 0 0 100vmax var(--dsw-alias-interactive-bg-hover,#8882);background:var(--dsw-alias-bg-layer-2,#fff)}
.mf-group[aria-expanded=true]{color:var(--dsw-alias-label-primary,inherit)}
.mf-group-chevron{flex:none;transform:rotate(-90deg);transition:transform .15s;color:var(--dsw-alias-label-tertiary,#9ca3af)}
.mf-group[aria-expanded=true] .mf-group-chevron{transform:none}
.mf-group-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-count{flex:none;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#9ca3af);font-variant-numeric:tabular-nums}
.mf-group-label{padding:6px 8px 2px;font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
.mf-empty{padding:14px 8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.mf-rounds{display:flex;align-items:center;gap:8px}
.mf-rounds .mf-trigger{width:72px}
.mf-where .mf-trigger{width:220px}
.mf-combos{display:flex;flex-direction:column;gap:8px}
.mf-combos-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px}
.mf-button{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l3,#d1d5db);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.mf-button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-button:disabled{color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:default}
.mf-combo-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.mf-combo{position:relative;min-width:0}
.mf-combo-apply{display:flex;flex-direction:column;gap:2px;width:100%;box-sizing:border-box;padding:7px 50px 7px 10px;border:1px solid var(--dsw-alias-border-l3,#d1d5db);border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mf-combo-apply:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.mf-combo-apply[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#517ee8);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#517ee8)}
.mf-combo-name,.mf-combo-models{display:block;width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mf-combo-name{font-weight:500}
.mf-combo-models{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.mf-combo[data-missing=true] .mf-combo-name,.mf-combo[data-missing=true] .mf-combo-models{color:var(--dsw-alias-label-tertiary,#9ca3af)}
.mf-combo-remove,.mf-combo-rename{position:absolute;top:5px;right:5px;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:14px;line-height:20px;cursor:pointer;opacity:0}
.mf-combo-rename{right:27px}
.mf-combo:hover :is(.mf-combo-remove,.mf-combo-rename),:is(.mf-combo-remove,.mf-combo-rename):focus-visible{opacity:1}
:is(.mf-combo-remove,.mf-combo-rename):hover{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}
@media (hover:none){.mf-combo-remove,.mf-combo-rename{opacity:1}}
.mf-combo-edit{grid-column:1/-1;flex-wrap:wrap}
.mf-combo-form input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.mf-combo-taken{flex-basis:100%;font-size:12px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.mf-combo-form{display:flex;gap:8px;align-items:center}
.mf-combo-form input{flex:1;min-width:0;height:26px;box-sizing:border-box;border:1px solid var(--dsw-alias-brand-primary,#517ee8);border-radius:6px;background:transparent;color:inherit;padding:0 8px;font:inherit;outline:0}
.mf-status{min-height:18px}
.mf-settings[data-embedded] .mf-status:empty{display:none}
.mf-status[data-tone=error]{color:var(--dsw-alias-state-error-primary,#dc2626)}
.mf-status button{margin-left:8px;font:inherit;background:none;border:1px solid var(--dsw-alias-border-l3,#d1d5db);border-radius:6px;padding:1px 8px;cursor:pointer;color:inherit}
@container (max-width:380px){.mf-row{grid-template-columns:minmax(0,1fr)}}
`;
const ROLES: readonly { role: Role; label: string; optional?: boolean }[] = [
  { role: 'plan', label: 'Plan', optional: true },
  { role: 'implement', label: 'Implement' },
  { role: 'review', label: 'Review' },
];
const shortName = (route: Route) => nameParts(route.provider, route.label).name;
const withoutCombos = ({ combos: _combos, worktree: _worktree, ...setup }: FlowConfig): Setup => setup;

function RoleRow({ label, optional, route, models, machines, change }: { label: string; optional?: boolean; route?: Route; models: CatalogModel[]; machines: readonly (string | undefined)[]; change(route: Route | undefined): void }) {
  const [efforts, setEfforts] = useState<EffortOption[]>([]);
  useEffect(() => {
    let live = true; setEfforts([]);
    if (route) void post<{ efforts: EffortOption[] }>({ action: 'efforts', provider: route.provider, model: route.model }).then(value => { if (live) setEfforts(value.efforts); }).catch(() => undefined);
    return () => { live = false; };
  }, [route?.provider, route?.model]);
  const value = route ? routeKey(route) : '';
  const groups = useMemo(() => modelGroups(models).map(group => ({
    id: group.id, name: group.name,
    options: group.rows.map(row => ({
      id: modelKey(preferredModel(row, [machineOf(route), ...machines, mainMachine(models)])), label: row.label, keywords: row.keywords,
      ...(row.models.length > 1 ? { choices: row.models.map(model => ({ id: modelKey(model), label: machineName(model) })) } : {}),
    })),
  })), [models, route?.provider, route?.model, machines.join()]);
  const known = !route || models.some(model => modelKey(model) === value);
  const parts = route && nameParts(route.provider, route.label);
  return <div className="mf-row"><label>{ui(label)}</label>
    <Select label={`${ui(label)} · ${ui('Model')}`} text={parts?.name ?? ui(optional ? 'Skip planning' : 'Choose a model')} tag={parts?.machine} warning={known ? undefined : ui('This model is not in the list right now.')}
      value={value} options={optional ? [{ id: '', label: ui('Skip planning') }] : []} groups={groups} search menuWidth={320} searchLabel={ui('Search models')} emptyLabel={ui(models.length ? 'No matching models' : 'No models available')}
      onChange={id => {
        const model = models.find(item => modelKey(item) === id);
        // Moving a model to another machine keeps its thinking level; another model starts from its own default.
        const kept = model && route?.effort && nativeModel(model) === nativeModel({ provider: route.provider, id: route.model }) && model.provider === route.provider ? { effort: route.effort } : {};
        change(model ? { provider: model.provider, model: model.id, label: model.name, ...kept } : undefined);
      }} />
    <Select label={`${ui(label)} · ${ui('Thinking')}`} disabled={!route || !efforts.length} text={efforts.find(effort => effort.id === route?.effort)?.label ?? route?.effort ?? ui('Default thinking')}
      value={route?.effort ?? ''} options={[{ id: '', label: ui('Default thinking') }, ...efforts.map(effort => ({ id: effort.id, label: effort.label }))]}
      onChange={id => { if (route) { const { effort: _old, ...rest } = route; change(id ? { ...rest, effort: id } : rest); } }} />
  </div>;
}
function comboDetails(combo: Combo, missing: readonly string[]): string {
  return [
    ...ROLES.map(({ role, label }) => { const route = combo[role]; return `${ui(label)}: ${route ? `${shortName(route)}${route.effort ? ` (${route.effort})` : ''}` : ui('Skip planning')}`; }),
    `${ui('Review rounds at most')}: ${combo.rounds}`,
    ...(missing.length ? [ui('Not in the list right now: {models}', { models: missing.join(', ') })] : []),
  ].join('\n');
}
const Pencil = () => <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8.2 1.8l2 2L4 10l-2.6.6L2 8z" /></svg>;
/** A combo's card while its name is being changed. Enter keeps the new name; Escape, or Cancel, leaves the old one. */
function ComboRename({ combo, combos, rename, close }: { combo: Combo; combos: readonly Combo[]; rename(name: string): void; close(): void }) {
  const form = useRef<HTMLFormElement>(null), [draft, setDraft] = useState(combo.name);
  useEscape(true, form, close);
  const name = comboName(draft), taken = name !== combo.name && combos.some(item => item.name === name);
  return <form ref={form} className="mf-combo-form mf-combo-edit" onSubmit={event => { event.preventDefault(); if (name && !taken) { if (name !== combo.name) rename(name); close(); } }}>
    <input autoFocus value={draft} maxLength={MAX_COMBO_NAME} aria-label={ui('Combination name')} aria-invalid={taken || undefined} onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} />
    <button type="submit" className="mf-button" disabled={!name || taken} title={taken ? ui('Another combination has this name.') : undefined}>{ui('Save')}</button>
    <button type="button" className="mf-button" onClick={close}>{ui('Cancel')}</button>
    {taken && <span className="mf-combo-taken" role="alert">{ui('Another combination has this name.')}</span>}
  </form>;
}
function Combos({ config, models, apply, store, remove, rename }: { config: FlowConfig; models: CatalogModel[]; apply(combo: Combo): void; store(name: string): void; remove(combo: Combo): void; rename(combo: Combo, name: string): void }) {
  const combos = config.combos ?? [], form = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<string | null>(null), [renaming, setRenaming] = useState<string | null>(null);
  useEscape(draft !== null, form, () => setDraft(null));
  const complete = !!config.implement && !!config.review, setup = withoutCombos(config), current = combos.find(combo => sameSetup(combo, setup));
  const blocked = !complete ? ui('Choose the implementing and reviewing models first.') : current ? ui('This is already saved as "{name}".', { name: current.name }) : undefined;
  const commit = () => { const name = draft?.trim(); if (name) { store(name); setDraft(null); } };
  return <div className="mf-combos">
    <div className="mf-combos-head"><span className="mf-combos-title">{ui('Common combinations')}</span>
      {draft === null && <button type="button" className="mf-button" disabled={!!blocked} title={blocked} onClick={() => setDraft('')}>{ui('Save current')}</button>}
    </div>
    {draft !== null && <form ref={form} className="mf-combo-form" onSubmit={event => { event.preventDefault(); commit(); }}>
      <input autoFocus value={draft} maxLength={MAX_COMBO_NAME} placeholder={ui('Combination name')} aria-label={ui('Combination name')} onChange={event => setDraft(event.target.value)} />
      <button type="submit" className="mf-button" disabled={!draft.trim()}>{ui(combos.some(combo => combo.name === draft.trim()) ? 'Replace' : 'Save')}</button>
      <button type="button" className="mf-button" onClick={() => setDraft(null)}>{ui('Cancel')}</button>
    </form>}
    {combos.length
      ? <div className="mf-combo-list">{combos.map(combo => {
        const { missing } = placeCombo(combo, models);
        if (renaming === combo.name) return <ComboRename key={combo.name} combo={combo} combos={combos} rename={name => rename(combo, name)} close={() => setRenaming(null)} />;
        return <div key={combo.name} className="mf-combo" data-missing={missing.length > 0}>
          <button type="button" className="mf-combo-apply" aria-pressed={combo === current} title={comboDetails(combo, missing)} onClick={() => apply(combo)}>
            <span className="mf-combo-name">{combo.name}</span>
            <span className="mf-combo-models">{[combo.plan, combo.implement, combo.review].flatMap(route => route ? [`${shortName(route)}${route.effort ? ` ${route.effort}` : ''}`] : []).join(' → ')}</span>
          </button>
          <button type="button" className="mf-combo-rename" aria-label={ui('Rename "{name}"', { name: combo.name })} title={ui('Rename "{name}"', { name: combo.name })} onClick={() => setRenaming(combo.name)}><Pencil /></button>
          <button type="button" className="mf-combo-remove" aria-label={ui('Delete "{name}"', { name: combo.name })} title={ui('Delete "{name}"', { name: combo.name })} onClick={() => remove(combo)}>×</button>
        </div>;
      })}</div>
      : <p className="mf-muted">{ui('Choose the models below and save them here to switch back in one click.')}</p>}
  </div>;
}
interface Status { text: string; tone?: 'error'; restore?: Combo[] }
/**
 * The combinations and the model of each job. `embedded` is this inside another plugin's settings page: that page has
 * its own heading and says what the models are for, and how many rounds its own work gets.
 */
function Setup({ embedded }: { embedded?: boolean }) {
  useLocale();
  const [data, setData] = useState<{ config: FlowConfig; models: CatalogModel[] } | null>(null), [status, setStatus] = useState<Status | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus({ text: ui('Loading…') });
    void fetch(API_PATH, { credentials: 'same-origin', signal: controller.signal }).then(response => response.json()).then((value: { config: FlowConfig; models: CatalogModel[] }) => {
      // Offered once, when there is something to offer; after that the list is the user's, even when emptied.
      const starters = value.config.combos ? [] : startersFor(value.models, ui);
      const config = starters.length ? { ...value.config, combos: starters } : value.config;
      setData({ ...value, config }); setStatus(null);
      if (starters.length) void post({ action: 'save', config }).catch(() => undefined);
    }).catch(() => { if (!controller.signal.aborted) setStatus({ text: ui('Could not load the models.'), tone: 'error' }); });
    return () => controller.abort();
  }, [revision]);
  const save = useCallback(async (config: FlowConfig, done: Omit<Status, 'tone'> = { text: ui('Saved') }) => {
    setData(current => current && { ...current, config }); setStatus({ text: ui('Saving…') });
    try { await post({ action: 'save', config }); setStatus(done); }
    catch (error) { setStatus({ text: error instanceof Error ? error.message : ui('Could not save.'), tone: 'error' }); }
  }, []);
  const applyCombo = (combo: Combo) => {
    if (!data) return;
    const { setup, missing } = placeCombo(combo, data.models);
    if (missing.length) { setStatus({ text: ui('Not in the list right now: {models}', { models: missing.join(', ') }), tone: 'error' }); return; }
    void save({ ...setup, ...(data.config.combos ? { combos: data.config.combos } : {}), ...(data.config.worktree ? { worktree: true } : {}) }, { text: ui('Using "{name}"', { name: combo.name }) });
  };
  const storeCombo = (name: string) => {
    if (!data?.config.implement || !data.config.review) return;
    const combos = data.config.combos ?? [], combo: Combo = { ...withoutCombos(data.config), name, implement: data.config.implement, review: data.config.review };
    const replaced = combos.some(item => item.name === name);
    void save({ ...data.config, combos: replaced ? combos.map(item => item.name === name ? combo : item) : [...combos, combo] }, { text: ui(replaced ? 'Replaced "{name}"' : 'Saved as "{name}"', { name }) });
  };
  const removeCombo = (combo: Combo) => {
    if (!data) return;
    const before = data.config.combos ?? [];
    void save({ ...data.config, combos: before.filter(item => item !== combo) }, { text: ui('Deleted "{name}"', { name: combo.name }), restore: before });
  };
  const renameTo = (combo: Combo, name: string) => {
    const combos = data && renameCombo(data.config.combos ?? [], combo.name, name);
    if (data && combos) void save({ ...data.config, combos }, { text: ui('Renamed to "{name}"', { name: comboName(name) }) });
  };
  const restore = status?.restore;
  return <section className="mf-settings" aria-label={ui('Model flow')} data-embedded={embedded || undefined}><style>{styles}</style>
    {!embedded && <h2>{ui('Model flow')}</h2>}
    {!embedded && <p className="mf-muted">{ui('Use /flow <goal> in any conversation. One model plans, one implements, one reviews, and rejected work goes back until it passes or the rounds run out. On a remote machine the same model on that machine is used.')}</p>}
    {data && <Combos config={data.config} models={data.models} apply={applyCombo} store={storeCombo} remove={removeCombo} rename={renameTo} />}
    {data && ROLES.map(({ role, label, optional }) => <RoleRow key={role} label={label} optional={optional} route={data.config[role]} models={data.models} machines={ROLES.map(item => machineOf(data.config[item.role]))}
      change={route => { const { [role]: _old, ...rest } = data.config; void save(route ? { ...rest, [role]: route } as FlowConfig : rest as FlowConfig); }} />)}
    {data && !embedded && <div className="mf-rounds"><label>{ui('Review rounds at most')}</label>
      <Select label={ui('Review rounds at most')} text={String(data.config.rounds)} value={String(data.config.rounds)} menuWidth={72}
        options={Array.from({ length: MAX_ROUNDS }, (_, index) => ({ id: String(index + 1), label: String(index + 1) }))}
        onChange={id => void save({ ...data.config, rounds: Number(id) })} /></div>}
    {data && !embedded && <div className="mf-rounds mf-where"><label>{ui('A typed /flow runs in')}</label>
      <Select label={ui('A typed /flow runs in')} text={ui(data.config.worktree ? 'A worktree of its own' : 'This conversation')} value={data.config.worktree ? 'worktree' : 'here'} menuWidth={220}
        options={[{ id: 'here', label: ui('This conversation') }, { id: 'worktree', label: ui('A worktree of its own') }]}
        onChange={id => { const { worktree: _old, ...rest } = data.config; void save(id === 'worktree' ? { ...rest, worktree: true } : rest); }} /></div>}
    {data && !embedded && <p className="mf-muted">{ui(data.config.worktree
      ? 'Each /flow gets a worktree, a branch and a conversation of its own through Autofix: after the review come the repository\'s checks, a commit, and your acceptance before anything is merged. wt=off on the line runs one here.'
      : 'The flow changes the files of the workspace this conversation is in, and ends when the review passes. wt=on on the line runs one in a worktree of its own instead, through Autofix.')}</p>}
    {data && <p className="mf-muted">{ui('Planning and review run read-only, so those models cannot change your files.')}</p>}
    <div className="mf-status" role="status" data-tone={status?.tone}>{status?.text}
      {status?.tone === 'error' && !data && <button type="button" onClick={() => setRevision(value => value + 1)}>{ui('Retry')}</button>}
      {restore && data && <button type="button" onClick={() => void save({ ...data.config, combos: restore })}>{ui('Undo')}</button>}
    </div>
  </section>;
}
/** The text of the composer an event came from, when it holds a /flow line. */
function typedFlow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const box = target.closest('textarea, [contenteditable="true"]') as HTMLTextAreaElement | HTMLElement | null;
  const text = box ? ('value' in box ? box.value : box.innerText) : '';
  return /^\s*\/flow\s+\S/u.test(text);
}
const composerOf = (button: Element) => { for (let node = button.parentElement; node; node = node.parentElement) { const box = node.querySelector('textarea, [contenteditable="true"]'); if (box) return box; } return null; };
/**
 * DSH stays on the new-session page after a command, so a flow started there would run out of sight. Once a /flow line
 * is sent, ask which conversation took it and open that one, which also shows a refusal that would otherwise go unseen.
 */
function installOpenAfterCommand(ctx: Client): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = () => {
    clearTimeout(timer);
    let tries = 0;
    const ask = () => {
      tries++;
      void post<{ sessionId: string | null }>({ action: 'lastCommand' }).then(({ sessionId }) => {
        const navigation = ctx.get?.('uiWorkspace') as { openSession?: (id: string) => void } | undefined;
        if (sessionId) navigation?.openSession?.(sessionId);
        else if (tries < 10) timer = setTimeout(ask, 400);
      }).catch(() => undefined);
    };
    timer = setTimeout(ask, 300);
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && typedFlow(event.target)) follow(); };
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button && button.querySelector('svg') && !button.textContent?.trim() && typedFlow(composerOf(button))) follow();
  };
  document.addEventListener('keydown', onKey, true); document.addEventListener('click', onClick, true);
  return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onClick, true); };
}
const Settings = () => <Setup />;
/** For another plugin's settings page that runs flows of its own, as the client service `modelFlowSettings`. */
const Models = () => <Setup embedded />;
interface Client extends Omit<LocaleContext, 'get'> {
  get?(name: string): unknown;
  provide?(name: string, value: unknown): () => void;
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
export const name = 'dsh-model-flow-client';
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => i18n.installLocale(ctx as LocaleContext));
  ctx.effect(() => {
    const send = () => { void post({ action: 'locale', locale: i18n.activeLocale() }).catch(() => undefined); };
    send();
    return i18n.subscribe(send);
  });
  ctx.effect(() => installOpenAfterCommand(ctx));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-model-flow'; style.textContent = flowRowStyles;
    document.head.appendChild(style);
    return () => style.remove();
  });
  const openStep = (parentSessionId: string, childSessionId: string) => {
    const address = { parentSessionId, childSessionId, mode: 'continuable' };
    const sidebar = ctx.get?.('sidebarRight') as { openResource?(resource: string, options: { kind: string; preferNewPane: boolean }): unknown } | undefined;
    if (sidebar?.openResource) sidebar.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(childSessionId)}?${new URLSearchParams({ parent: parentSessionId, mode: address.mode })}`, { kind: 'subagentchat', preferNewPane: true });
    else (ctx.get?.('uiWorkspace') as { openSession?(target: typeof address): void } | undefined)?.openSession?.(address);
  };
  const Row: React.FC<{ node: React.ComponentProps<typeof FlowRow>['node'] }> = ({ node }) => <FlowRow node={node} openStep={openStep} />;
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'flow' }, Row as React.FC));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'model-flow', order: 75, label: () => ui('Model flow') }, Settings));
  // The card itself, for a plugin that runs flows of its own and has more to show around them.
  const View: React.FC<FlowView & ViewExtras> = props => <FlowCardView {...props} openStep={openStep} />;
  ctx.effect(() => {
    try { return ctx.provide?.('modelFlowCard', { version: 1, View, extend } satisfies ModelFlowCard) ?? (() => undefined); }
    catch (error) { console.warn('[dsh-model-flow] Could not offer the flow card to other plugins', error); return () => undefined; }
  });
  // A host that refuses the service keeps the rest of the plugin working; the models are then chosen on this plugin's own page.
  ctx.effect(() => {
    try { return ctx.provide?.('modelFlowSettings', { version: 1, Models }) ?? (() => undefined); }
    catch (error) { console.warn('[dsh-model-flow] Could not offer the model choice to other plugins', error); return () => undefined; }
  });
}
