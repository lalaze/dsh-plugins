import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { DesktopIcon } from '@phosphor-icons/react/dist/csr/Desktop';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives';
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Dashboard, DirectoryListing, Host, RemoteWorkspace } from '../domain.js';
import { api } from './api.js';
import { localizeError, ui, useLocale } from './i18n.js';
import { styles } from './styles.js';

/** DSH's directory-flow owner conversation: one outcome per rising `open` edge. */
export interface DirectoryFlowProps { open: boolean; busy: boolean; onPicked(path: string): void; onCancel(): void; onError(message: string): void }
interface LocalListing { path: string; home: string; crumbs?: { path: string }[]; entries: { name: string; path: string; hidden?: boolean }[]; truncated: boolean }
/** DSH's Host directory API (`uiWorkspace`). A native composition serves `pickDirectory`; a browse composition serves `listDirectory`. */
export interface LocalDirectories {
  pickDirectory(): Promise<string | null>;
  listDirectory?(path?: string, signal?: AbortSignal): Promise<LocalListing>;
}
/** The two Add workspace holes. Both are `single`; the native picker sits at priority 0, dsh-remote at -100. */
export const DIRECTORY_FLOWS = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'] as const;
export const DIRECTORY_FLOW_PRIORITY = -50;

interface Listing { path: string; home: string; parent?: string; entries: { name: string; path: string; hidden: boolean }[]; truncated: boolean }
type Lister = (path: string | undefined, signal: AbortSignal) => Promise<Listing>;
type Picked = { path: string } | { cancelled: true } | { browse: true };
type Tab = 'local' | 'remote';

const TAB_KEY = 'dsh-remote-agents.workspace-flow.tab', HOST_KEY = 'dsh-remote-agents.workspace-flow.host';
const pathKey = (hostId: string) => `dsh-remote-agents.workspace-flow.path.${hostId}`;
const recall = (key: string) => { try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } };
const remoteParent = (path: string) => path === '/' ? undefined : path.replace(/\/[^/]+\/?$/, '') || '/';

/** DSH's own chooser: the Desktop bridge, else the Host's native picker. A browse composition refuses the pick verb. */
async function pickNative(local: () => LocalDirectories | undefined): Promise<Picked> {
  const bridge = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__;
  if (bridge) { const path = await bridge.pick(); return path === null ? { cancelled: true } : { path }; }
  const service = local();
  if (!service) throw new Error('Choosing a folder on this computer is unavailable');
  try { const path = await service.pickDirectory(); return path === null ? { cancelled: true } : { path }; }
  catch (error) { if (service.listDirectory) return { browse: true }; throw error; }
}

function FolderBrowser({ list, initialPath, busy, onCommit }: { list: Lister; initialPath?: string; busy: boolean; onCommit(path: string): void }) {
  const [target, setTarget] = useState(initialPath), [reload, setReload] = useState(0);
  const [listing, setListing] = useState<Listing>(), [input, setInput] = useState(initialPath ?? '');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [hidden, setHidden] = useState(false);
  // A remembered folder that no longer exists falls back to the home folder once.
  const fallback = useRef(initialPath !== undefined);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    list(target, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      fallback.current = false; setListing(next); setInput(next.path); setLoading(false);
    }, failure => {
      if (controller.signal.aborted) return;
      if (fallback.current) { fallback.current = false; setTarget(undefined); return; }
      setError(localizeError(failure)); setLoading(false);
    });
    return () => controller.abort();
  }, [list, target, reload]);
  const go = (path: string) => { fallback.current = false; setTarget(path); setReload(value => value + 1); };
  const entries = listing?.entries.filter(entry => hidden || !entry.hidden) ?? [];
  // Commit only the folder last listed successfully, and only while the path field still shows it.
  const confirmed = !!listing && !loading && !error && input.trim() === listing.path;
  return <div className="ra-flow-browser">
    <form className="ra-flow-path" onSubmit={event => { event.preventDefault(); if (input.trim()) go(input.trim()); }}>
      <button type="button" className="ra-icon-button" aria-label={ui('Up one level')} title={ui('Up one level')} disabled={loading || !listing?.parent} onClick={() => listing?.parent && go(listing.parent)}><ArrowUpIcon size={15} /></button>
      <button type="button" className="ra-icon-button" aria-label={ui('Home folder')} title={ui('Home folder')} disabled={loading || !listing} onClick={() => listing && go(listing.home)}><HouseIcon size={15} /></button>
      <input className="ra-mono" aria-label={ui('Folder path')} value={input} spellCheck={false} autoComplete="off" onChange={event => setInput(event.target.value)} />
      <button type="submit" disabled={!input.trim()}>{ui('Go')}</button>
    </form>
    <div className="ra-flow-list" aria-busy={loading}>
      {entries.map(entry => <button type="button" key={entry.path} className="ra-flow-entry" data-hidden={entry.hidden || undefined} disabled={loading} onClick={() => go(entry.path)}>
        <FolderSimpleIcon size={16} /><span>{entry.name}</span>
      </button>)}
      {loading ? <div className="ra-flow-note" role="status">{ui('Loading folders…')}</div>
        : listing && !entries.length ? <div className="ra-flow-note">{ui('No subfolders')}</div> : null}
    </div>
    {listing?.truncated && <p className="ra-foot">{ui('Some folders are not shown. Type a path to open one directly.')}</p>}
    {error && <div className="ra-banner" data-tone="error" role="alert">{error}</div>}
    <div className="ra-flow-foot">
      <label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />{ui('Show hidden folders')}</label>
      <button type="button" className="ra-primary" disabled={!confirmed || busy} onClick={() => confirmed && onCommit(listing.path)}>{busy ? ui('Opening…') : ui('Use this folder')}</button>
    </div>
  </div>;
}

function MachineSelect({ hosts, value, disabled, onChange }: { hosts: Host[]; value?: string; disabled: boolean; onChange(id: string): void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(value ?? '');
  const selected = hosts.find(host => host.id === value);
  const activeId = active ? id + '-option-' + hosts.findIndex(host => host.id === active) : undefined;
  const close = (restoreFocus = false) => {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const element = popup.current; if (!element) return;
    // React 18 does not type or forward popover target properties consistently.
    element.setAttribute('popover', 'auto'); trigger.current?.setAttribute('popovertarget', id);
    const before = (event: Event) => {
      if ((event as ToggleEvent).newState === 'open') { setActive(value ?? hosts[0]?.id ?? ''); setOpen(true); } else setOpen(false);
    };
    element.addEventListener('beforetoggle', before);
    return () => element.removeEventListener('beforetoggle', before);
  }, [value, id, hosts]);
  useEffect(() => { if (disabled) close(); }, [disabled]);
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
        width: width + 'px', left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)) + 'px',
        top: up ? 'auto' : (bottom + gap) + 'px', bottom: up ? (window.innerHeight - top + gap) + 'px' : 'auto',
        maxHeight: Math.max(0, Math.min(360, up ? above : below)) + 'px',
      });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    // Capture Escape before the dialog's own cancel handler can close the whole flow.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !popup.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  useEffect(() => { if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [open, activeId]);
  const choose = (next: string) => { onChange(next); close(true); };
  const step = (delta: number) => {
    if (!hosts.length) return;
    const index = hosts.findIndex(host => host.id === active);
    setActive(hosts[(index + delta + hosts.length) % hosts.length]?.id ?? '');
  };
  return <div className="ra-field ra-machine-select">
    <span>{ui('Machine')}</span>
    <button ref={trigger} type="button" className="ra-machine-trigger" aria-label={ui('Machine')} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-activedescendant={open ? activeId : undefined} disabled={disabled}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) popup.current?.showPopover(); else step(event.key === 'ArrowDown' ? 1 : -1); }
        else if (open && event.key === 'Enter') { event.preventDefault(); if (active) choose(active); }
      }}>
      <span className="ra-machine-trigger-icon"><MachineGlyph kind="server" /></span><span className="ra-machine-trigger-text">
        <span className="ra-machine-label"><span className="ra-machine-dot" data-status={selected?.status ?? 'disconnected'} /><span className="ra-machine-name">{selected?.label ?? ui('Choose a machine…')}</span></span>
        {selected && <span className="ra-machine-connection">{selected.connection}</span>}
      </span><MachineGlyph kind="chevron" />
    </button>
    {/* The native top layer stays interactive inside <dialog> and escapes scrolling-panel clipping. */}
    <div id={id} ref={popup} className="ra-machine-menu" role="listbox" aria-label={ui('Machine')} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}>
      {hosts.map(host => <div key={host.id} id={id + '-option-' + hosts.indexOf(host)} role="option" aria-selected={host.id === value} data-active={host.id === active} className="ra-machine-item" title={host.label}
        onPointerMove={() => setActive(host.id)} onMouseDown={event => event.preventDefault()} onClick={() => choose(host.id)}>
        <span className="ra-machine-item-icon"><MachineGlyph kind="server" /></span>
        <span className="ra-machine-item-text"><span className="ra-machine-item-name"><span className="ra-machine-dot" data-status={host.status} /><span className="ra-machine-name">{host.label}</span></span><span className="ra-machine-item-connection">{host.connection}</span></span>
        {host.id === value && <MachineGlyph kind="check" />}
      </div>)}
    </div>
  </div>;
}

function MachineGlyph({ kind }: { kind: 'server' | 'chevron' | 'check' }) {
  const paths = { server: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>, chevron: <path d="m6 9 6 6 6-6" />, check: <path d="m5 12 4 4L19 6" /> };
  return <svg aria-hidden="true" className={kind === 'chevron' ? 'ra-machine-chevron' : undefined} width={kind === 'chevron' ? 14 : 16} height={kind === 'chevron' ? 14 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

function FlowDialog({ hosts, initialTab, localBrowse, busy, local, onPicked, onCancel }: {
  hosts: Host[]; initialTab: Tab; localBrowse: boolean; busy: boolean; local: () => LocalDirectories | undefined; onPicked(path: string): void; onCancel(): void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>(hosts.length ? initialTab : 'local'), [browseLocal, setBrowseLocal] = useState(localBrowse);
  const [hostId, setHostId] = useState(() => hosts.find(host => host.id === recall(HOST_KEY))?.id ?? hosts[0]?.id);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const action = useRef<AbortController>();
  useEffect(() => {
    const element = dialog.current, focused = document.activeElement;
    element?.showModal();
    return () => { action.current?.abort(); element?.close(); if (focused instanceof HTMLElement) focused.focus(); };
  }, []);
  const cancel = () => { action.current?.abort(); onCancel(); };
  const host = hosts.find(entry => entry.id === hostId);
  const switchTab = (next: Tab) => { setTab(next); setError(''); remember(TAB_KEY, next); };
  const localList = useCallback<Lister>(async (path, signal) => {
    const service = local();
    if (!service?.listDirectory) throw new Error('Choosing a folder on this computer is unavailable');
    const listing = await service.listDirectory(path, signal);
    return { path: listing.path, home: listing.home, parent: listing.crumbs?.at(-2)?.path, truncated: listing.truncated, entries: listing.entries.map(entry => ({ name: entry.name, path: entry.path, hidden: entry.hidden === true })) };
  }, [local]);
  const remoteList = useCallback<Lister>(async (path, signal) => {
    const listing = await api<DirectoryListing>('browse', { hostId, ...(path ? { path } : {}) }, signal);
    return { ...listing, parent: remoteParent(listing.path), entries: listing.entries.map(entry => ({ ...entry, hidden: entry.name.startsWith('.') })) };
  }, [hostId]);
  const run = async (task: (signal: AbortSignal) => Promise<void>) => {
    action.current?.abort();
    const controller = new AbortController(); action.current = controller;
    setPending(true); setError('');
    try { await task(controller.signal); }
    catch (failure) { if (!controller.signal.aborted) setError(localizeError(failure)); }
    finally { if (action.current === controller) { action.current = undefined; setPending(false); } }
  };
  const pickLocal = () => run(async signal => {
    const picked = await pickNative(local);
    if (signal.aborted) return;
    if ('path' in picked) onPicked(picked.path); else if ('browse' in picked) setBrowseLocal(true);
  });
  const adoptRemote = (path: string) => run(async signal => {
    if (!hostId) return;
    const workspace = await api<RemoteWorkspace>('createWorkspace', { hostId, path }, signal);
    if (signal.aborted) return;
    remember(pathKey(hostId), workspace.remotePath);
    onPicked(workspace.path);
  });
  const locked = pending || busy;
  return createPortal(<dialog ref={dialog} className="dsh-ra ra-flow" aria-label={ui('Add workspace')} onCancel={event => { event.preventDefault(); cancel(); }}>
    <style>{styles}</style>
    <div className="ra-dialog-bar"><span>{ui('Add workspace')}</span><button type="button" aria-label={ui('Close')} onClick={cancel}><XIcon size={17} /></button></div>
    <div className="ra-flow-body">
      {hosts.length > 0 && <div className="ra-flow-tabs" role="tablist" aria-label={ui('Workspace location')}>
        <button type="button" role="tab" aria-selected={tab === 'local'} onClick={() => switchTab('local')}><DesktopIcon size={16} />{ui('This computer')}</button>
        <button type="button" role="tab" aria-selected={tab === 'remote'} onClick={() => switchTab('remote')}><HardDrivesIcon size={16} />{ui('Remote machine')}</button>
      </div>}
      {tab === 'local' ? (browseLocal ? <FolderBrowser list={localList} busy={locked} onCommit={onPicked} />
        : <div className="ra-flow-local">
          <p className="ra-muted">{ui('Open a folder on this computer with the system folder picker.')}</p>
          <button type="button" className="ra-primary" disabled={locked} onClick={() => void pickLocal()}><FolderSimpleIcon size={16} />{ui('Choose a folder…')}</button>
        </div>)
        : <>
          <MachineSelect hosts={hosts} value={hostId} disabled={locked} onChange={id => { setHostId(id); setError(''); remember(HOST_KEY, id); }} />
          {hostId && <FolderBrowser key={hostId} list={remoteList} initialPath={recall(pathKey(hostId))} busy={locked} onCommit={path => void adoptRemote(path)} />}
          {host && <p className="ra-foot">{ui('Files stay on {host}. Remote models in this workspace run there.', { host: host.label })}</p>}
        </>}
      {error && <div className="ra-banner" data-tone="error" role="alert">{error}</div>}
    </div>
  </dialog>, document.body);
}

/**
 * Add workspace with a Remote machine choice. Without saved machines it is DSH's own picker: the OS chooser opens directly.
 * Like the native occupant, each rising `open` edge settles exactly once; a superseded request is dropped.
 */
export function workspaceFlow(local: () => LocalDirectories | undefined): React.FC<DirectoryFlowProps> {
  return function WorkspaceFlow(props) {
    const latest = useRef(props); latest.current = props;
    const request = useRef(0), armed = useRef(false), settled = useRef(0);
    const [dialog, setDialog] = useState<{ request: number; hosts: Host[]; tab: Tab; localBrowse: boolean }>();
    /** Report one outcome for an open request; later outcomes and superseded requests are dropped. */
    const settle = (current: number, report: (owner: DirectoryFlowProps) => void) => {
      if (request.current !== current || settled.current === current || !latest.current.open) return;
      settled.current = current; report(latest.current);
    };
    // Unmounting drops the pending request; a remount (StrictMode, hot reload) re-arms an open flow.
    useEffect(() => () => { request.current++; armed.current = false; }, []);
    useEffect(() => {
      if (!props.open) { armed.current = false; request.current++; setDialog(undefined); return; }
      if (armed.current) return;
      armed.current = true;
      const current = ++request.current, live = () => request.current === current && latest.current.open;
      void (async () => {
        let hosts: Host[] = [];
        try { hosts = (await api<Dashboard>()).hosts; } catch { /* without the settings API, behave as DSH's own picker */ }
        if (!live()) return;
        if (hosts.length) { setDialog({ request: current, hosts, tab: recall(TAB_KEY) === 'remote' ? 'remote' : 'local', localBrowse: false }); return; }
        try {
          const picked = await pickNative(local);
          if (!live()) return;
          if ('path' in picked) settle(current, owner => owner.onPicked(picked.path));
          else if ('cancelled' in picked) settle(current, owner => owner.onCancel());
          else setDialog({ request: current, hosts, tab: 'local', localBrowse: true });
        } catch (error) { settle(current, owner => owner.onError(localizeError(error))); }
      })();
    }, [props.open]);
    if (!dialog) return null;
    return <FlowDialog hosts={dialog.hosts} initialTab={dialog.tab} localBrowse={dialog.localBrowse} busy={props.busy} local={local}
      onPicked={path => settle(dialog.request, owner => owner.onPicked(path))} onCancel={() => settle(dialog.request, owner => owner.onCancel())} />;
  };
}
