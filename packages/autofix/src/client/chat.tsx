import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Route } from '../domain.js';
import { ACTIVE } from '../domain.js';
import { parseRow } from '../shared.js';
import { call, type State } from './api.js';
import { failure, Said, TaskCard } from './board.js';
import { ui, useLocale } from './i18n.js';

type TaskView = State['tasks'][number];
/** A command's row as DSH hands it to the plugin that draws it; `outcome` is null while the command runs. */
export interface CommandNode { commandId: string; args?: string | null; outcome: { kind: 'success' | 'error'; text?: string } | null }
const LIVE_MS = 2500, QUIET_MS = 12_000;
/** A task another DSH runs is read through a machine both reach: asked less often. */
const FAR_LIVE_MS = 4000, FAR_QUIET_MS = 25_000;

/**
 * A /fix row in a conversation. It follows one task: the row a typed /fix left behind always shows the task as it is
 * now; the cards the task puts into its own conversation are numbered, and only the newest one can be acted on.
 */
export function FixRow({ node, open }: { node: CommandNode; open(sessionId: string): void }) {
  useLocale();
  const row = useMemo(() => parseRow(node.outcome?.text ?? ''), [node.outcome?.text]), key = row.meta?.key, at = row.meta?.at;
  const far = at ? { at } : {};
  const [view, setView] = useState<{ task: TaskView | null; routes: Route[] }>(), [error, setError] = useState<Message>(), [busy, setBusy] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => undefined);
  const active = !!view?.task && (view.task.running || ACTIVE.includes(view.task.status));
  useEffect(() => {
    if (!key) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const reply = await call<{ task: TaskView | null; routes: Route[] }>('task', { key, ...far }); if (alive) setView({ task: reply.task, routes: reply.routes ?? [] }); }
      catch { /* DSH may be restarting: the next round asks again. */ }
    };
    refresh.current = load;
    const loop = async () => { await load(); if (alive) timer = setTimeout(loop, document.hidden || !active ? (at ? FAR_QUIET_MS : QUIET_MS) : at ? FAR_LIVE_MS : LIVE_MS); };
    void loop();
    return () => { alive = false; clearTimeout(timer); };
  }, [key, at, active]);

  if (node.outcome === null) return <div className="tp-chat"><p className="tp-chat-line">{ui("Handing the bug in…")}</p></div>;
  if (row.meta?.said) return <div className="tp-chat"><div className="tp-chat-line" data-error={node.outcome.kind === 'error' || undefined}><Said message={row.meta.said} error={node.outcome.kind === 'error'} /></div></div>;
  if (!key) return <div className="tp-chat"><p className={node.outcome.kind === 'error' ? 'tp-error' : 'tp-chat-line'}>{row.words}</p></div>;
  if (!view) return <div className="tp-chat"><p className="tp-chat-line">{row.words}</p></div>;
  const task = view.task;
  if (!task) return <div className="tp-chat"><p className="tp-chat-line">{row.words} · {at ? ui("waiting for the DSH that runs it") : ui("this task was removed")}</p></div>;
  // An earlier card of the same task: what it asked has been answered since, further down.
  if (row.meta?.home && (row.meta.card ?? 0) < (task.cards ?? 0)) return <div className="tp-chat"><p className="tp-chat-line">{row.words} · {ui("there is a newer card below")}</p></div>;
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(undefined);
    try { await call(action, { key, ...far, ...body }); await refresh.current(); return true; }
    catch (reason) { setError(failure(reason)); await refresh.current(); return false; }
    finally { setBusy(false); }
  };
  return <div className="tp-chat">
    <TaskCard task={task} routes={view.routes} busy={busy} act={act} {...(row.meta?.home || at ? {} : { open })} {...far} keep />
    {at && <p className="tp-chat-line">{ui("Another DSH runs this fix; this card follows it.")}</p>}
    {error && <Said message={error} error />}
  </div>;
}

const typedFix = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  const box = target.closest('textarea, [contenteditable="true"]') as HTMLTextAreaElement | HTMLElement | null;
  const text = box ? ('value' in box ? box.value : box.innerText) : '';
  return /^\s*\/fix(?:\s|$)/u.test(text);
};
const composerOf = (button: Element) => { for (let node = button.parentElement; node; node = node.parentElement) { const box = node.querySelector('textarea, [contenteditable="true"]'); if (box) return box; } return null; };
/**
 * DSH stays on the new-conversation page after a command, so a bug handed in there would vanish from sight. Once a /fix
 * line is sent, ask which conversation took it and open that one.
 */
export function installOpenAfterFix(open: (sessionId: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = () => {
    clearTimeout(timer);
    let tries = 0;
    const ask = () => {
      tries++;
      void call<{ sessionId: string | null }>('lastCommand').then(({ sessionId }) => {
        if (sessionId) open(sessionId);
        else if (tries < 10) timer = setTimeout(ask, 400);
      }).catch(() => undefined);
    };
    timer = setTimeout(ask, 300);
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && typedFix(event.target)) follow(); };
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button && button.querySelector('svg') && !button.textContent?.trim() && typedFix(composerOf(button))) follow();
  };
  document.addEventListener('keydown', onKey, true); document.addEventListener('click', onClick, true);
  return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onClick, true); };
}
