import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Host, SshConfigHost } from '../../core/domain.js';
import { ui } from '../i18n.js';

function Icon({ kind }: { kind: 'server' | 'search' | 'chevron' | 'check' }) {
  const paths = { server: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>, search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>, chevron: <path d="m7 10 5 5 5-5" />, check: <path d="m5 12 4 4L19 6" /> };
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

export function SshAliasSelect({ options, hosts, connection, disabled, loading, select }: { options: SshConfigHost[]; hosts: Host[]; connection: string; disabled: boolean; loading: boolean; select: (host: SshConfigHost) => void }) {
  const id = useId(), listId = `${id}-list`;
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState('');
  const selected = options.find(option => option.connection === connection);
  const saved = (option: SshConfigHost) => hosts.some(host => host.connection === option.connection);
  const filtered = options.filter(option => option.alias.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const enabled = filtered.filter(option => !saved(option));
  const activeId = active ? `${id}-option-${options.findIndex(option => option.connection === active)}` : undefined;
  const unavailable = disabled || loading || !options.length;
  const close = (restoreFocus = false) => {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const element = popup.current; if (!element) return;
    // React 18 does not type or forward popover target properties consistently.
    element.setAttribute('popover', 'auto'); trigger.current?.setAttribute('popovertarget', id);
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState === 'open') {
        setQuery(''); setActive(connection); setOpen(true);
      } else setOpen(false);
    };
    element.addEventListener('beforetoggle', before);
    return () => element.removeEventListener('beforetoggle', before);
  }, [connection, id]);
  useEffect(() => { if (unavailable) close(); }, [unavailable]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current, element = popup.current; if (!anchor || !element) return;
      const rect = anchor.getBoundingClientRect(), gap = 6, margin = 12;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - margin * 2);
      // A viewport resize can move the trigger offscreen while its top-layer menu stays open.
      const top = Math.max(margin, Math.min(rect.top, window.innerHeight - margin));
      const bottom = Math.max(margin, Math.min(rect.bottom, window.innerHeight - margin));
      const below = window.innerHeight - bottom - margin - gap, above = top - margin - gap;
      const up = below < 240 && above > below;
      Object.assign(element.style, {
        width: `${width}px`, left: `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`,
        top: up ? 'auto' : `${bottom + gap}px`, bottom: up ? `${window.innerHeight - top + gap}px` : 'auto',
        maxHeight: `${Math.max(0, Math.min(352, up ? above : below))}px`,
      });
    };
    place(); search.current?.focus({ preventScroll: true });
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    // Capture Escape before the settings dialog's shortcut handler can close its own layer.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !popup.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  useEffect(() => {
    if (!enabled.some(option => option.connection === active)) setActive(enabled[0]?.connection ?? '');
  }, [query, options, hosts, active]);
  useEffect(() => { if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [open, activeId]);
  const choose = (option: SshConfigHost) => { if (!saved(option)) { select(option); close(true); } };
  return <div className="ra-field ra-ssh-select">
    <span>{ui('SSH config host')}</span>
    <button ref={trigger} type="button" className="ra-ssh-trigger" aria-label={ui('SSH config host')} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={unavailable}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); popup.current?.showPopover(); } }}>
      <Icon kind="server" /><span className={!selected ? 'ra-ssh-placeholder' : ''}>{selected?.alias ?? ui(loading ? 'Loading SSH config…' : 'Choose an SSH alias…')}</span><Icon kind="chevron" />
    </button>
    {/* The native top layer stays interactive inside <dialog> and escapes scrolling-panel clipping. */}
    <div id={id} ref={popup} className="ra-ssh-menu" role="dialog" aria-label={ui('Choose SSH connection')} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
      <div className="ra-ssh-search"><Icon kind="search" /><input ref={search} role="combobox" aria-label={ui('Search SSH aliases')} aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={activeId} autoComplete="off" spellCheck={false} placeholder={ui('Search SSH aliases…')} value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
          if (event.key === 'Enter') { event.preventDefault(); const option = enabled.find(option => option.connection === active); if (option) choose(option); }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); const index = enabled.findIndex(option => option.connection === active), delta = event.key === 'ArrowDown' ? 1 : -1;
            setActive(enabled[(index + delta + enabled.length) % enabled.length]?.connection ?? '');
          } else if (event.key === 'Tab') close();
        }} /></div>
      <div id={listId} role="listbox" aria-label={ui('SSH config host')} className="ra-ssh-options">
        {filtered.map(option => <div key={option.alias} id={`${id}-option-${options.indexOf(option)}`} role="option" aria-selected={option.connection === connection} aria-disabled={saved(option)} data-connection={option.connection} data-active={option.connection === active} className="ra-ssh-item" title={option.alias}
          onPointerMove={() => { if (!saved(option)) setActive(option.connection); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
          <span className="ra-ssh-item-icon"><Icon kind="server" /></span><span className="ra-ssh-item-name">{option.alias}</span>{saved(option) ? <span className="ra-ssh-saved">{ui('Already saved')}</span> : option.connection === connection && <Icon kind="check" />}
        </div>)}
        {!filtered.length && <p className="ra-ssh-no-results" role="status">{ui('No matching SSH aliases')}</p>}
      </div>
      <div className="ra-ssh-footer"><span role="status">{ui('{count} connections', { count: filtered.length })}</span><span aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> {ui('Navigate')} <kbd>↵</kbd> {ui('Select')}</span></div>
    </div>
  </div>;
}
