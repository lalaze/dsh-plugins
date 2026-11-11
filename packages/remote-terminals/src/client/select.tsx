import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ui } from './i18n.js';

export interface SelectOption {
  id: string;
  label: string;
  /** A second line, such as a path. */
  detail?: string;
  /** Short marks after the label, such as `origin/main` or `↑2`. */
  marks?: string[];
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Why an option is disabled, or more about it. */
  note?: string;
}
const SHOWN = 200;

/**
 * A listbox in the native top layer, like Machine: a trigger showing the choice, and a menu that stays interactive inside
 * a modal <dialog>. With `search`, a filter field sits above the options and arrow keys move through what it matches.
 */
export function PopoverSelect({ label, options, value, placeholder, disabled, search, icon, onChange }: {
  label: string; options: SelectOption[]; value?: string; placeholder: string; disabled?: boolean; search?: boolean; icon?: React.ReactNode; onChange(id: string): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), filter = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(value ?? '');
  const selected = options.find(option => option.id === value);
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => words.every(word => `${option.label} ${option.detail ?? ''} ${(option.marks ?? []).join(' ')}`.toLowerCase().includes(word)));
  }, [options, query]);
  const shown = matches.slice(0, SHOWN), enabled = shown.filter(option => !option.disabled);
  const activeId = active && shown.some(option => option.id === active) ? `${id}-option-${shown.findIndex(option => option.id === active)}` : undefined;
  const close = (restoreFocus = false) => {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const element = popup.current; if (!element) return;
    element.setAttribute('popover', 'auto'); trigger.current?.setAttribute('popovertarget', id);
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState === 'open') { setQuery(''); setActive(value ?? options.find(option => !option.disabled)?.id ?? ''); setOpen(true); }
      else setOpen(false);
    };
    element.addEventListener('beforetoggle', before);
    return () => element.removeEventListener('beforetoggle', before);
  }, [value, id, options]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    if (search) filter.current?.focus({ preventScroll: true });
    const place = () => {
      const anchor = trigger.current, element = popup.current; if (!anchor || !element) return;
      const rect = anchor.getBoundingClientRect(), gap = 6, margin = 12;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - margin * 2);
      const top = Math.max(margin, Math.min(rect.top, window.innerHeight - margin));
      const bottom = Math.max(margin, Math.min(rect.bottom, window.innerHeight - margin));
      const below = window.innerHeight - bottom - margin - gap, above = top - margin - gap, up = below < 260 && above > below;
      Object.assign(element.style, {
        width: `${width}px`, left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`,
        top: up ? 'auto' : `${bottom + gap}px`, bottom: up ? `${window.innerHeight - top + gap}px` : 'auto',
        maxHeight: `${Math.max(0, Math.min(380, up ? above : below))}px`,
      });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    // Escape closes the menu before the dialog's own cancel handler can close the whole flow.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !popup.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', escape, true); };
  }, [open, search]);
  useEffect(() => { if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [open, activeId]);
  const choose = (next: string) => { onChange(next); close(true); };
  const step = (delta: number) => {
    if (!enabled.length) return;
    const index = enabled.findIndex(option => option.id === active);
    setActive(enabled[index < 0 ? 0 : (index + delta + enabled.length) % enabled.length].id);
  };
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) popup.current?.showPopover(); else step(event.key === 'ArrowDown' ? 1 : -1); }
    else if (open && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const target = enabled.find(option => option.id === active) ?? enabled[0];
      if (target) choose(target.id);
    }
  };
  return <div className="ra-field ra-machine-select ra-select">
    <span>{label}</span>
    <button ref={trigger} type="button" className="ra-machine-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id}
      aria-activedescendant={open && !search ? activeId : undefined} disabled={disabled} onKeyDown={keys}>
      {icon && <span className="ra-machine-trigger-icon">{selected?.icon ?? icon}</span>}
      <span className="ra-machine-trigger-text">
        <span className="ra-machine-label"><span className="ra-machine-name">{selected?.label ?? placeholder}</span>{selected?.marks?.map(mark => <span key={mark} className="ra-select-mark">{mark}</span>)}</span>
        {selected?.detail && <span className="ra-machine-connection" title={selected.detail}>{selected.detail}</span>}
      </span><CaretDownIcon size={14} className="ra-machine-chevron" />
    </button>
    <div id={id} ref={popup} className="ra-machine-menu ra-select-menu" onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
      {search && <label className="ra-select-search"><MagnifyingGlassIcon size={14} />
        <input ref={filter} value={query} placeholder={ui('Search')} aria-label={ui('Search')} aria-controls={`${id}-list`} aria-activedescendant={activeId} spellCheck={false} autoComplete="off"
          onChange={event => { setQuery(event.target.value); setActive(''); }} onKeyDown={keys} /></label>}
      <div id={`${id}-list`} role="listbox" aria-label={label}>
        {shown.map((option, index) => <div key={option.id} id={`${id}-option-${index}`} role="option" aria-selected={option.id === value} aria-disabled={option.disabled || undefined}
          data-active={option.id === active} className="ra-machine-item" title={option.note ?? option.label}
          onPointerMove={() => { if (!option.disabled) setActive(option.id); }} onMouseDown={event => event.preventDefault()} onClick={() => { if (!option.disabled) choose(option.id); }}>
          {option.icon && <span className="ra-machine-item-icon">{option.icon}</span>}
          <span className="ra-machine-item-text">
            <span className="ra-machine-item-name"><span className="ra-machine-name">{option.label}</span>{option.marks?.map(mark => <span key={mark} className="ra-select-mark">{mark}</span>)}</span>
            {(option.note ?? option.detail) && <span className="ra-machine-item-connection">{option.note ?? option.detail}</span>}
          </span>
          {option.id === value && <CheckIcon size={15} />}
        </div>)}
        {!shown.length && <div className="ra-select-empty">{ui('No matches')}</div>}
        {matches.length > SHOWN && <div className="ra-select-empty">{ui('Showing {shown} of {count}. Type to narrow the list.', { shown: String(SHOWN), count: String(matches.length) })}</div>}
      </div>
    </div>
  </div>;
}
