import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ui } from './i18n.js';

export interface Option { value: string; label: string }
const SEARCH_FROM = 8;

/**
 * A choice from a list that may be long (a repository's branches, a monorepo's packages): a button showing the choice,
 * and a list over the page with a search box once there is enough to search. Arrow keys, Enter and Escape work.
 */
export function Pick({ label, value, options, onChange, placeholder, disabled }: { label: string; value: string; options: readonly Option[]; onChange(value: string): void; placeholder?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [at, setAt] = useState(0), [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const button = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const current = options.find(option => option.value === value), needle = query.trim().toLowerCase();
  const shown = needle ? options.filter(option => option.label.toLowerCase().includes(needle)) : options;
  const close = (focus = true) => { setOpen(false); setQuery(''); if (focus) button.current?.focus(); };
  const choose = (option: Option | undefined) => { if (!option) return; close(); if (option.value !== value) onChange(option.value); };
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect(), height = Math.min(320, window.innerHeight - 24), below = window.innerHeight - rect.bottom - 8;
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
    setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: below >= Math.min(height, 200) ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height), width, height: below >= Math.min(height, 200) ? Math.min(height, below) : height });
    setAt(Math.max(0, options.findIndex(option => option.value === value)));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    (search.current ?? list.current)?.focus();
    const outside = (event: PointerEvent) => { if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) close(false); };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', outside as never);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', outside as never); };
  }, [open, box]);
  useEffect(() => { list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' }); }, [at, open, box]);
  const key = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setAt(index => Math.min(shown.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setAt(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(shown[at]); }
    else if (event.key === 'Tab') close(false);
  };
  return <>
    <button ref={button} type="button" className="tp-pick" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} title={current?.label} data-empty={!current || undefined}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); } }}>
      <span>{current?.label ?? placeholder ?? label}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
    </button>
    {open && box && createPortal(<div ref={list} className="tp-pick-list" role="listbox" aria-label={label} tabIndex={-1} style={{ left: box.left, top: box.top, width: box.width, maxHeight: box.height }} onKeyDown={key}>
      {options.length >= SEARCH_FROM && <input ref={search} className="tp-pick-search" value={query} placeholder={ui("Search…")} aria-label={ui("Search…")} spellCheck={false} onChange={event => { setQuery(event.target.value); setAt(0); }} />}
      <div className="tp-pick-options">
        {shown.map((option, index) => <div key={option.value} role="option" aria-selected={option.value === value} data-active={index === at || undefined} onPointerEnter={() => setAt(index)} onClick={() => choose(option)}>{option.label}</div>)}
        {!shown.length && <p>{ui("Nothing matches")}</p>}
      </div>
    </div>, document.body)}
  </>;
}
