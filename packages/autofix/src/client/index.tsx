import type { LocaleContext } from '@dsh-plugins/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { call } from './api.js';
import { Board } from './board.js';
import { FixRow, installOpenAfterFix, type CommandNode } from './chat.js';
import { installLocale, ui, useLocale } from './i18n.js';
import { AutofixSettings } from './settings.js';
import { CSS } from './styles.js';

interface Client {
  effect(factory: () => () => void): void;
  get?(name: string): unknown;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
const PILL_REFRESH_MS = 15_000;
let client: Client | undefined;
/** Shows the task's conversation and gets the board out of its way. */
function openSession(sessionId: string, close: () => void): void {
  (client?.get?.('uiWorkspace') as { openSession?(id: string): void } | undefined)?.openSession?.(sessionId);
  close();
}

/** The board in a modal window. Escape, the close button or the backdrop closes it, and focus goes back to what opened it. */
function BoardDialog({ onClose }: { onClose(): void }) {
  const close = useRef<HTMLButtonElement>(null), latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    close.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) { event.stopPropagation(); latest.current(); } };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (opener?.isConnected) opener.focus(); };
  }, []);
  return createPortal(<div className="tp-overlay"><style>{CSS}</style>
    <div className="tp-mask" onPointerDown={onClose} />
    <div className="tp-dialog" role="dialog" aria-modal="true" aria-label={ui("Bugs")}>
      <button ref={close} type="button" className="tp-close" aria-label={ui("Close")} title={ui("Close")} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
      <div className="tp-dialog-body"><Board open={sessionId => openSession(sessionId, onClose)} /></div>
    </div>
  </div>, document.body);
}

/** In the conversation header once a source is there or a task exists: how many fixes wait for you, and a dot while tasks run. */
function HeaderPill() {
  useLocale();
  const [counts, setCounts] = useState<{ review: number; running: number }>(), [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => call('state').then(reply => {
      if (!alive || !reply.state) return;
      const { sources, tasks } = reply.state;
      setCounts(sources.length || tasks.length ? { review: tasks.filter(task => task.status === 'review').length, running: tasks.filter(task => task.running).length } : undefined);
    }, () => undefined);
    void load();
    const timer = setInterval(() => void load(), PILL_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [open]);
  if (!counts) return null;
  const title = counts.review ? ui("Bugs: {0} waiting for you", { 0: String(counts.review) }) : counts.running ? ui("Bugs: {0} running", { 0: String(counts.running) }) : ui("Bugs");
  return <><style>{CSS}</style>
    <button type="button" className="tp-pill" title={title} aria-label={title} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      {counts.running > 0 && <i aria-hidden="true" />}{ui("Bugs")}{counts.review > 0 && <b>{counts.review}</b>}
    </button>
    {open && <BoardDialog onClose={() => setOpen(false)} />}
  </>;
}
function SettingsSection() {
  const [open, setOpen] = useState(false);
  return <><style>{CSS}</style><AutofixSettings board={() => setOpen(true)} />{open && <BoardDialog onClose={() => setOpen(false)} />}</>;
}

export const name = 'dsh-autofix-client';
// The desktop language bridge initializes asynchronously; wait before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  client = ctx;
  ctx.effect(() => installLocale(ctx as LocaleContext));
  ctx.effect(() => () => { if (client === ctx) client = undefined; });
  const open = (sessionId: string) => (ctx.get?.('uiWorkspace') as { openSession?(id: string): void } | undefined)?.openSession?.(sessionId);
  // Rows in conversations are many; one stylesheet in the page serves them all.
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-autofix'; style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.effect(() => installOpenAfterFix(open));
  const Row: React.FC<{ node: CommandNode }> = ({ node }) => <FixRow node={node} open={open} />;
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'fix' }, Row as React.FC));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'autofix', order: 72, label: () => ui("Autofix") }, SettingsSection));
  // A host that rejects the entry keeps the rest of the plugin working.
  ctx.slots.inject('conversation.session.header.utilities', () => {
    try { return ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'autofix-board', order: -900, label: () => ui("Bugs") }, HeaderPill); }
    catch (error) { console.warn('[dsh-autofix] Could not add the bugs button to the conversation header', error); return undefined; }
  });
}
