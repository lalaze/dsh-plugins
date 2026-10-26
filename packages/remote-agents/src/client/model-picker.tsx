import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ui, useLocale } from './i18n.js';
import { modelPickerStyles } from './model-picker-styles.js';

// Public DSH ModelDirectory / conversation.input.model contract (0.2.1-rc.2).
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface PickerModel { id: string; name: string; description?: string; reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string } }
export interface PickerGroup { id: string; name: string; models: readonly PickerModel[] }
export interface ModelDirectoryState {
  current: ModelSelection | null; retainedEffort?: string; groups: readonly PickerGroup[];
  failures: readonly { id: string; name: string; message: string }[];
  status: string; pending: ModelSelection | null; error: string | null;
}
export interface PickerStore { getSnapshot(): ModelDirectoryState; subscribe(listener: () => void): () => void }
export type SelectionResult = { ok: true } | { ok: false; error: { code: string; message: string } } | undefined;
export interface ModelPickerProps {
  locked?: boolean; available: boolean; directory: PickerStore; load(): void;
  select(selection: ModelSelection): Promise<SelectionResult>;
  renderSlot?(name: string, owner: { provider: { id: string; name: string }; model: PickerModel; placement: 'trigger' | 'menu' | 'option'; selected: boolean }, options: { fallback: string }): React.ReactNode;
}

const STORAGE_KEY = 'dsh-remote-agents:model-groups:v1', CHANGE_EVENT = 'dsh-remote-model-groups';
let memory: Record<string, boolean> = {};
function readGroups(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) memory = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean'));
  } catch { /* Storage may be unavailable; folding still works for this tab. */ }
  return memory;
}
const providerOrder = (id: string) => id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2;

/** Native model seat with collapsible groups; reads and writes the host's shared directory. */
export function GroupedModelPicker({ locked, available, directory, load, select, renderSlot }: ModelPickerProps) {
  // The browser ModuleLoader supplies CommonJS require. Delay DOM/CSS primitives until the seat mounts.
  const { MenuSurface, rankByName, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCheckOutlineRegular, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives') as typeof import('@deepseek-ai/dsh-client-ui-primitives');
  useLocale();
  const state = useSyncExternalStore(listener => directory.subscribe(listener), () => directory.getSnapshot());
  const [open, setOpen] = useState(false), [pane, setPane] = useState<'root' | 'model' | 'effort'>('root'), [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(readGroups), [highlight, setHighlight] = useState(''), [error, setError] = useState(''), [sending, setSending] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: 'hidden' });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), lifetime = useRef(0);
  const id = useId(), busy = sending || state.pending !== null;
  const groups = useMemo(() => [...state.groups].sort((a, b) => providerOrder(a.id) - providerOrder(b.id)), [state.groups]);
  const currentGroup = groups.find(g => g.id === state.current?.provider), current = currentGroup?.models.find(m => m.id === state.current?.model);
  const reasoning = current?.reasoning, effort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortName = reasoning ? reasoning.efforts.find(e => e.id === effort)?.name ?? (effort || ui('Provider default')) : state.retainedEffort;
  const filtered = useMemo(() => groups.map(group => ({ ...group, models: rankByName(group.models, query.trim()) })).filter(g => g.models.length), [groups, query, rankByName]);
  const expanded = (provider: string) => !!query.trim() || !(typeof collapsed[provider] === 'boolean' ? collapsed[provider] : provider !== state.current?.provider);
  const modelKey = (provider: string, model: string) => JSON.stringify([provider, model]);
  const visible = filtered.flatMap(g => expanded(g.id) ? g.models.map(m => ({ provider: g.id, model: m.id })) : []);
  const active = visible.find(m => modelKey(m.provider, m.model) === highlight) ?? visible.find(m => m.provider === state.current?.provider && m.model === state.current.model) ?? visible[0];
  const activeKey = active && modelKey(active.provider, active.model);

  useEffect(() => {
    const changed = () => setCollapsed({ ...readGroups() });
    const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) changed(); };
    window.addEventListener(CHANGE_EVENT, changed); window.addEventListener('storage', storage);
    return () => { window.removeEventListener(CHANGE_EVENT, changed); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => {
    lifetime.current++; setOpen(false); setSending(false); setError('');
    return () => { lifetime.current++; };
  }, [directory]);
  useEffect(() => { if (!available || locked) setOpen(false); }, [available, locked]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!menu.current || !trigger.current) return;
      const box = trigger.current.getBoundingClientRect(), width = menu.current.offsetWidth, height = menu.current.offsetHeight;
      setPosition({ left: Math.max(12, Math.min(box.right - width, innerWidth - width - 12)), top: Math.max(12, Math.min(box.top - height - 8, innerHeight - height - 12)) });
    };
    place(); const observer = new ResizeObserver(place); if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, pane]);
  useEffect(() => {
    if (!open) return;
    if (pane === 'model') search.current?.focus();
    else (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('[data-picker-row]:not(:disabled)'))?.focus();
  }, [open, pane]);
  useEffect(() => {
    if (open && pane === 'model' && highlight) menu.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, pane, highlight]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const toggle = (provider: string, collapse = expanded(provider)) => {
    const next = { ...readGroups(), [provider]: collapse }; memory = next; setCollapsed(next); setHighlight('');
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  const choose = async (selection: ModelSelection) => {
    if (busy || locked) return;
    if (selection.provider === state.current?.provider && selection.model === state.current.model && (pane !== 'effort' || selection.reasoningEffort === effort)) { close(); return; }
    const generation = lifetime.current; setSending(true); setError('');
    try {
      const result = await select(selection);
      if (generation !== lifetime.current) return;
      if (result?.ok) close();
      else setError(result && !result.ok ? result.error.message : ui('Model selection is unavailable.'));
    } catch (e) { if (generation === lifetime.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation === lifetime.current) setSending(false); }
  };
  const back = () => { if (pane !== 'root' && current) { setPane('root'); setQuery(''); } else close(); };
  const keydown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' || event.key === 'Tab' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); back(); return; }
    if (event.target === search.current && ['ArrowDown', 'ArrowUp'].includes(event.key) && visible.length) {
      event.preventDefault();
      const at = visible.findIndex(m => modelKey(m.provider, m.model) === activeKey), next = visible[(at + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length];
      setHighlight(modelKey(next.provider, next.model)); return;
    }
    if (event.target === search.current && (event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) && active) {
      event.preventDefault(); void choose(active); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target !== search.current || event.target === search.current && !visible.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      const rows = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[data-picker-row]:not(:disabled)') ?? []);
      if (!rows.length) return;
      event.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLButtonElement), direction = event.key === 'ArrowUp' ? -1 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : at < 0 ? direction > 0 ? 0 : rows.length - 1 : (at + direction + rows.length) % rows.length;
      rows[next].focus();
    }
  };
  const label = (group: PickerGroup, model: PickerModel, placement: 'trigger' | 'menu' | 'option') => <span data-provider-id={group.id} data-model-id={model.id}>{renderSlot
    ? renderSlot('conversation.input.model.label', { provider: { id: group.id, name: group.name }, model, placement, selected: state.current?.provider === group.id && state.current.model === model.id }, { fallback: model.name })
    : model.name}</span>;

  if (!available) return null;
  return <div className="ra-model-picker"><style>{modelPickerStyles}</style>
    <button className="ra-model-trigger" type="button" ref={trigger} disabled={locked} aria-label={ui('Choose model')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} aria-busy={busy}
      onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); setPane(current ? 'root' : 'model'); setQuery(''); setHighlight(''); load(); } }}
      onClick={() => { if (open) close(); else { setOpen(true); setPane(current ? 'root' : 'model'); setQuery(''); setHighlight(''); setError(''); load(); } }}>
      <span>{current && currentGroup ? label(currentGroup, current, 'trigger') : ui(state.status === 'loading' ? 'Loading models…' : 'Choose model')}</span>
      {effortName && <span className="ra-model-effort">{effortName}</span>}{busy ? <StateDot state="ongoing" /> : <IconChevronDownOutlineRegular size={14} />}
    </button>
    {open && createPortal(<MenuSurface className="ra-model-menu" ref={menu} id={`${id}-menu`} style={position} role={pane === 'model' ? 'group' : 'menu'} aria-label={ui('Model selection')} aria-busy={busy || state.status === 'loading'} onKeyDown={keydown}
      onBlur={event => { if (event.relatedTarget instanceof Node && !menu.current?.contains(event.relatedTarget) && !trigger.current?.contains(event.relatedTarget)) setOpen(false); }}>
      {pane === 'root' ? <>
        <button type="button" data-picker-row className="ra-model-root-row" onClick={() => setPane('model')}><span>{ui('Model')}</span><span>{current && currentGroup ? label(currentGroup, current, 'menu') : ui('Choose model')}</span><IconChevronRightOutlineRegular size={14} /></button>
        {reasoning && <button type="button" data-picker-row className="ra-model-root-row" onClick={() => setPane('effort')}><span>{ui('Thinking level')}</span><span>{effortName}</span><IconChevronRightOutlineRegular size={14} /></button>}
      </> : pane === 'effort' && state.current && reasoning ? <div className="ra-model-options">
        {[...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: ui('Provider default') }] : []), ...reasoning.efforts].map(level => <button key={level.id ?? 'default'} type="button" data-picker-row role="menuitemradio" aria-checked={effort === level.id} disabled={busy || locked} className="ra-model-option"
          onClick={() => void choose({ provider: state.current!.provider, model: state.current!.model, ...(level.id !== undefined ? { reasoningEffort: level.id } : {}) })}><span>{level.name}</span>{effort === level.id && <IconCheckOutlineRegular size={14} />}</button>)}
      </div> : <>
        <div className="ra-model-search"><input ref={search} type="text" role="searchbox" aria-label={ui('Search models')} placeholder={ui('Search models')} value={query} readOnly={busy} aria-controls={`${id}-groups`} aria-activedescendant={activeKey ? `${id}-model-${visible.findIndex(m => modelKey(m.provider, m.model) === activeKey)}` : undefined}
          onChange={e => { setQuery(e.target.value); setHighlight(''); }} />{query && <button type="button" aria-label={ui('Clear model search')} disabled={busy} onClick={() => { setQuery(''); setHighlight(''); search.current?.focus(); }}>×</button>}</div>
        {state.status === 'loading' && <p className="ra-model-status" role="status">{ui('Loading models…')}</p>}
        {state.failures.map(failure => <p key={failure.id} className="ra-model-error">{failure.name}: {failure.message}<button type="button" onClick={load}>{ui('Retry')}</button></p>)}
        <div className="ra-model-groups" id={`${id}-groups`} role="menu" aria-label={ui('Models by provider')}>
          {filtered.map((group, groupIndex) => {
            const isOpen = expanded(group.id), selectedHere = state.current?.provider === group.id;
            return <section key={group.id} data-model-provider={group.id} role="group" aria-labelledby={`${id}-provider-${groupIndex}`}>
              <button type="button" id={`${id}-provider-${groupIndex}`} data-picker-row className="ra-model-group-toggle" role="menuitem" aria-expanded={isOpen} aria-controls={`${id}-group-${groupIndex}`} disabled={busy || !!query.trim()} onClick={() => toggle(group.id)}
                onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); toggle(group.id, event.key === 'ArrowLeft'); } }}>
                {isOpen ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}<span>{group.name}</span><span className="ra-model-count">{group.models.length}</span>{selectedHere && <span className="ra-model-current" title={ui('Current provider')}>●</span>}
              </button>
              {isOpen && <div id={`${id}-group-${groupIndex}`}>{group.models.map(model => {
                const key = modelKey(group.id, model.id), index = visible.findIndex(m => m.provider === group.id && m.model === model.id), selected = selectedHere && state.current?.model === model.id;
                return <button key={model.id} type="button" data-picker-row data-model-option={key} id={`${id}-model-${index}`} role="menuitemradio" aria-checked={selected} className="ra-model-option" data-active={key === activeKey} disabled={busy || locked}
                  onFocus={() => setHighlight(key)} onPointerMove={() => { if (!busy) setHighlight(key); }} onClick={() => void choose({ provider: group.id, model: model.id })}>
                  <span>{label(group, model, 'option')}</span>{selected && <IconCheckOutlineRegular size={14} />}
                </button>;
              })}</div>}
            </section>;
          })}
          {!filtered.length && state.status !== 'loading' && <p className="ra-model-status" role="status">{ui(query ? 'No matching models.' : 'No models available.')}</p>}
        </div>
      </>}
      {(error || state.error) && <p className="ra-model-error" role="alert">{error || state.error}<button type="button" onClick={() => { setError(''); load(); }}>{ui('Retry')}</button></p>}
    </MenuSurface>, document.body)}
  </div>;
}
