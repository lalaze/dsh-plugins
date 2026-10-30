import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Branch, Summary } from '../domain.js';
import { git, requestId } from './api.js';
import { registerComposer, type InputActions } from './composer.js';
import { localizeError, ui, useLocale } from './i18n.js';
import { Icon } from './icons.js';
import { useCwd } from './sessions.js';
import { announceChange, onChange } from './store.js';
import { styles } from './styles.js';

/** What DSH's `conversation.input.dock` slot passes to its entries. */
export interface DockProps { sessionId?: string; inputActions?: InputActions; useInput?: <T>(select: (state: { draft: string }) => T) => T }

/**
 * The current branch above the composer; choosing a local branch from its list switches to it. Hidden outside Git
 * repositories. It also lends the conversation's composer to the Git view's "send to chat" actions.
 */
export function Dock({ sessionId, inputActions, useInput }: DockProps) {
  useLocale();
  const draft = useInput?.(state => state.draft) ?? '', latest = useRef(draft);
  latest.current = draft;
  useEffect(() => sessionId && inputActions ? registerComposer(sessionId, { actions: inputActions, draft: () => latest.current }) : undefined, [sessionId, inputActions]);
  return sessionId ? <BranchChip sessionId={sessionId} /> : null;
}

function BranchChip({ sessionId }: { sessionId: string }) {
  const cwd = useCwd(sessionId);
  const [current, setCurrent] = useState<string | null>(null), [branches, setBranches] = useState<Branch[]>();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [up, setUp] = useState(false);
  const chip = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null), box = useRef<HTMLDivElement>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) { setCurrent(null); return; }
    try {
      const summary = await git<Summary>('summary', { sessionId }, signal);
      if (alive.current && !signal?.aborted) setCurrent(summary.current || null);
    } catch { if (alive.current && !signal?.aborted) setCurrent(null); }
  }, [sessionId, cwd]);
  useEffect(() => { const c = new AbortController(); void refresh(c.signal); return () => c.abort(); }, [refresh]);
  useEffect(() => onChange(root => { if (root === cwd) void refresh(); }), [cwd, refresh]);
  // The full list is read each time it opens, so starting and switching conversations stay cheap.
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    setLoading(true); setError('');
    git<Summary & { local: Branch[] }>('branches', { sessionId }, c.signal).then(view => { if (!c.signal.aborted) { setBranches(view.local); setCurrent(view.current || null); } },
      e => { if (!c.signal.aborted) setError(localizeError(e)); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
    return () => c.abort();
  }, [open, sessionId]);
  // A press anywhere else closes the list. The composer is its own stacking context, so a backdrop could not cover the page.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);
  // Opens upward when there is no room below, as above the composer there usually is not.
  useLayoutEffect(() => {
    if (!open || !chip.current) return;
    const place = () => {
      const rect = chip.current!.getBoundingClientRect(), below = window.innerHeight - rect.bottom, height = pop.current?.getBoundingClientRect().height ?? 240;
      const upward = below < height + 10;
      setUp(upward);
      if (pop.current) pop.current.style.maxHeight = `${Math.min(340, upward ? Math.max(160, rect.top - 12) : Math.max(120, below - 12))}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, branches, error, loading]);
  if (current === null) return null;
  const choose = async (branch: string) => {
    if (busy || branch === current) { setOpen(false); return; }
    setBusy(true); setError('');
    try {
      await git('switch', { sessionId, branch, requestId: requestId() });
      setOpen(false); setCurrent(branch);
      if (cwd) announceChange(cwd);
    } catch (e) { setError(localizeError(e)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="gv-chip" ref={box}><style>{styles}</style>
    <button ref={chip} type="button" title={ui('Switch branch')} aria-haspopup="listbox" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
      <Icon name="branch" size={12} /><span>{current}</span>{busy ? <span className="gv-spinner" aria-label={ui('Loading…')} /> : <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>}
    </button>
    {open && <>
      <div ref={pop} className="gv-chip-pop" role="listbox" aria-label={ui('Local branches')} style={up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); chip.current?.focus(); } }}>
        <div>{ui('Local branches')}</div>
        {error && <p role="alert">{error}</p>}
        {loading && !branches && <p>{ui('Loading…')}</p>}
        {branches && !branches.length && <p>{ui('No local branches')}</p>}
        {branches?.map(branch => <button type="button" role="option" key={branch.name} aria-selected={branch.name === current} onClick={() => void choose(branch.name)}>
          <span>{branch.name === current && <Icon name="check" size={12} />}</span><span>{branch.name}</span>
          {(branch.ahead || branch.behind) ? <span>{branch.ahead ? `↑${branch.ahead}` : ''}{branch.behind ? `↓${branch.behind}` : ''}</span> : null}
        </button>)}
      </div>
    </>}
  </div>;
}
