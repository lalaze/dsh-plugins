import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface SelectChoice { id: string; label: string }
export interface SelectOption {
  id: string;
  label: string;
  /** More words the search finds this row by. */
  keywords?: string;
  /** Other ways to pick this row, drawn as small buttons on it: the machines a model runs on. */
  choices?: readonly SelectChoice[];
}
export interface SelectGroup { id: string; name: string; options: readonly SelectOption[] }
type Stop = { key: string; option: SelectOption; group?: undefined } | { key: string; group: string; option?: undefined };
const groupKey = (id: string) => `group:${id}`;

const Chevron = ({ className }: { className: string }) => <svg className={className} aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>;
const Check = () => <svg className="mf-check" aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3 7.5 2.8 2.8L11 4.5" /></svg>;
const Search = () => <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="6" cy="6" r="4" /><path d="m9.2 9.2 3 3" /></svg>;

/** Escape ends `run`'s layer before the settings dialog's own shortcut can close the whole page. */
export function useEscape(active: boolean, inside: React.RefObject<HTMLElement>, run: () => void): void {
  const latest = useRef(run); latest.current = run;
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !inside.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); latest.current();
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [active, inside]);
}
/**
 * A dropdown in the native top layer, which stays interactive inside a modal <dialog> and escapes the settings panel's
 * clipping. With several groups one is open at a time, at first the one holding the current choice; searching shows all matches.
 */
export function Select({ label, text, tag, warning, value, options = [], groups = [], search, disabled, menuWidth = 0, searchLabel, emptyLabel, className, onChange }: {
  label: string; text: string; tag?: string; warning?: string; value: string; options?: readonly SelectOption[]; groups?: readonly SelectGroup[];
  search?: boolean; disabled?: boolean; menuWidth?: number; searchLabel?: string; emptyLabel?: string; className?: string; onChange(id: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), filter = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(''), [choice, setChoice] = useState(-1);
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/u).filter(Boolean), [query]);
  const hit = (option: SelectOption, group = '') => words.every(word => `${option.label} ${option.keywords ?? ''} ${group}`.toLowerCase().includes(word));
  const loose = options.filter(option => hit(option));
  const shownGroups = groups.map(group => ({ ...group, options: group.options.filter(option => hit(option, group.name)) })).filter(group => group.options.length);
  const foldable = groups.length > 1 && !words.length;
  const stops: Stop[] = [
    ...loose.map(option => ({ key: option.id, option })),
    ...shownGroups.flatMap((group): Stop[] => [
      ...(foldable ? [{ key: groupKey(group.id), group: group.id }] : []),
      ...(!foldable || expanded.has(group.id) ? group.options.map(option => ({ key: option.id, option })) : []),
    ]),
  ];
  // By place in the whole list, so a row keeps its id while groups above it fold.
  const allKeys = [...options.map(option => option.id), ...groups.flatMap(group => [groupKey(group.id), ...group.options.map(option => option.id)])];
  const stopId = (key: string) => `${id}-stop-${allKeys.indexOf(key)}`;
  // While searching, the first match is what Enter takes, so it shows as the active row.
  const current = stops.find(stop => stop.key === active) ?? (words.length ? stops.find(stop => stop.option) : undefined);
  const scrollTo = (key: string) => document.getElementById(stopId(key))?.scrollIntoView({ block: 'nearest' });
  const close = (restoreFocus = false) => {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useEscape(open, popup, () => close(true));
  // Read when the menu opens; the listener below is bound once.
  const latest = useRef({ value, groups, options }); latest.current = { value, groups, options };
  useLayoutEffect(() => {
    const element = popup.current; if (!element) return;
    // React 18 does not forward the popover attributes consistently.
    element.setAttribute('popover', 'auto'); trigger.current?.setAttribute('popovertarget', id);
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState !== 'open') { setOpen(false); return; }
      const { value: chosen, groups: all, options: loose } = latest.current;
      const holding = all.find(group => group.options.some(option => option.id === chosen || option.choices?.some(item => item.id === chosen)));
      setQuery(''); setExpanded(new Set(holding ? [holding.id] : []));
      setActive(loose.some(option => option.id === chosen) || holding ? chosen : loose[0]?.id ?? (all[0] ? groupKey(all[0].id) : ''));
      setChoice(-1); setOpen(true);
    };
    element.addEventListener('beforetoggle', before);
    return () => element.removeEventListener('beforetoggle', before);
  }, [id]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    if (search) filter.current?.focus({ preventScroll: true });
    const place = () => {
      const anchor = trigger.current, element = popup.current; if (!anchor || !element) return;
      const rect = anchor.getBoundingClientRect(), gap = 4, margin = 12;
      const width = Math.min(Math.max(rect.width, menuWidth), window.innerWidth - margin * 2);
      const top = Math.max(margin, Math.min(rect.top, window.innerHeight - margin));
      const bottom = Math.max(margin, Math.min(rect.bottom, window.innerHeight - margin));
      const below = window.innerHeight - bottom - margin - gap, above = top - margin - gap, up = below < 220 && above > below;
      Object.assign(element.style, {
        width: `${width}px`, left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`,
        top: up ? 'auto' : `${bottom + gap}px`, bottom: up ? `${window.innerHeight - top + gap}px` : 'auto',
        maxHeight: `${Math.max(0, Math.min(340, up ? above : below))}px`,
      });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, search, menuWidth]);
  useEffect(() => { if (open && current) scrollTo(current.key); }, [open]);
  const choose = (next: string) => { onChange(next); close(true); };
  /** One group open at a time keeps the menu short. The rows appear under the heading, so it moves up to show them. */
  const toggle = (group: string, to = !expanded.has(group)) => {
    setExpanded(new Set(to ? [group] : []));
    if (to) requestAnimationFrame(() => document.getElementById(stopId(groupKey(group)))?.scrollIntoView({ block: 'start' }));
  };
  const step = (delta: number) => {
    if (!stops.length) return;
    const index = stops.findIndex(stop => stop.key === current?.key), next = stops[index < 0 ? 0 : (index + delta + stops.length) % stops.length];
    setActive(next.key); setChoice(-1); scrollTo(next.key);
  };
  const sideways = (event: React.KeyboardEvent, delta: number) => {
    if (query) return; // The arrows belong to the search text then.
    if (current?.group !== undefined) { event.preventDefault(); toggle(current.group, delta > 0); }
    else if (current?.option?.choices) {
      event.preventDefault();
      const count = current.option.choices.length;
      setChoice(index => index < 0 ? (delta > 0 ? 0 : count - 1) : index + delta < 0 || index + delta >= count ? -1 : index + delta);
    }
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) popup.current?.showPopover(); else step(event.key === 'ArrowDown' ? 1 : -1); }
    else if (!open) return;
    else if (event.key === 'ArrowRight') sideways(event, 1);
    else if (event.key === 'ArrowLeft') sideways(event, -1);
    else if (event.key === 'Enter') {
      event.preventDefault();
      if (current?.group !== undefined) toggle(current.group);
      else if (current?.option) choose(current.option.choices?.[choice]?.id ?? current.option.id);
    }
  };
  const row = (option: SelectOption) => {
    const picked = option.id === value || !!option.choices?.some(item => item.id === value);
    return <div key={option.id} id={stopId(option.id)} role="option" aria-selected={picked} data-active={option.id === current?.key} className="mf-option" title={option.label}
      onPointerMove={() => { if (active !== option.id) { setActive(option.id); setChoice(-1); } }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option.id)}>
      <span className="mf-option-label">{option.label}</span>
      {option.choices && <span className="mf-choices">{option.choices.map((item, index) => <button key={item.id} type="button" tabIndex={-1} className="mf-choice" aria-pressed={item.id === value}
        data-active={option.id === current?.key && choice === index} onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); choose(item.id); }}>{item.label}</button>)}</span>}
      {picked && <Check />}
    </div>;
  };
  return <>
    <button ref={trigger} type="button" className={`mf-trigger${className ? ` ${className}` : ''}`} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} title={warning ?? text}
      aria-activedescendant={open && !search && current ? stopId(current.key) : undefined} disabled={disabled} onKeyDown={keys}>
      <span className="mf-trigger-text">{text}</span>
      {tag && <span className="mf-tag">{tag}</span>}
      {warning && <span className="mf-warning" aria-label={warning}>!</span>}
      <Chevron className="mf-chevron" />
    </button>
    <div id={id} ref={popup} className="mf-menu" onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
      {search && <label className="mf-search"><Search />
        <input ref={filter} value={query} placeholder={searchLabel} aria-label={searchLabel} aria-controls={`${id}-list`} aria-activedescendant={current ? stopId(current.key) : undefined} spellCheck={false} autoComplete="off"
          onChange={event => { setQuery(event.target.value); setActive(''); setChoice(-1); }} onKeyDown={keys} /></label>}
      <div id={`${id}-list`} className="mf-list" role="listbox" aria-label={label}>
        {loose.map(row)}
        {shownGroups.map(group => <div key={group.id} role="group" aria-label={group.name}>
          {foldable
            ? <div id={stopId(groupKey(group.id))} role="button" aria-expanded={expanded.has(group.id)} data-active={groupKey(group.id) === current?.key} className="mf-group"
              onPointerMove={() => setActive(groupKey(group.id))} onMouseDown={event => event.preventDefault()} onClick={() => toggle(group.id)}>
              <Chevron className="mf-group-chevron" /><span className="mf-group-name">{group.name}</span><span className="mf-count">{group.options.length}</span>
            </div>
            : groups.length > 1 && <div className="mf-group-label">{group.name}</div>}
          {(!foldable || expanded.has(group.id)) && group.options.map(row)}
        </div>)}
        {!stops.length && <div className="mf-empty">{emptyLabel}</div>}
      </div>
    </div>
  </>;
}
