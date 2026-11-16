/** Restarting the DSH this page shows: the dialog, and what the page shows while that machine restarts. */
import React, { useEffect, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { RestartRecord } from '../restart/state.js';
import type { RestartStatus } from '../restart/service.js';
import { ui, useLocale } from './i18n.js';
import { machineName } from './notify.js';
import { loadRestart, onScreen, requestRestart, useStore } from './store.js';

const ACTIVE = new Set(['waiting', 'armed', 'quitting', 'launching']);
export const isActive = (record: RestartRecord | undefined) => !!record && ACTIVE.has(record.phase);

export function RestartDialog({ open, onClose, name }: { open: boolean; onClose: () => void; name: string }) {
  useLocale();
  const [status, setStatus] = useState<RestartStatus | undefined>();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!open) return;
    setStatus(undefined); setError('');
    void loadRestart().then(answer => answer ? setStatus(answer) : setError(ui('{name} does not answer.', { name })));
  }, [open, name]);
  const send = async (action: 'now' | 'idle') => {
    setSending(true); setError('');
    try { await requestRestart(action); onClose(); } catch (cause) { setError((cause as Error).message); } finally { setSending(false); }
  };
  const busy = status ? status.busy.sessions.length + status.busy.jobs.length : 0;
  const footer = <>
    <Button variant="ghost" className="dm-nowrap" onClick={onClose}>{ui('Cancel')}</Button>
    {busy > 0 && <Button variant="outline" className="dm-nowrap" disabled={!status?.supported || sending} onClick={() => void send('idle')}>{ui('Restart when idle')}</Button>}
    <Button variant="primary" className="dm-nowrap" disabled={!status?.supported || sending} onClick={() => void send('now')}>{ui('Restart now')}</Button>
  </>;
  return <Modal open={open} onClose={onClose} title={ui('Restart DSH on {name}?', { name })} closeLabel={ui('Close')} footer={footer}>
    <div className="dm-dialog">
      {!status && !error && <p className="dm-muted">{ui('Checking what runs there…')}</p>}
      {status && !status.supported && <p className="dm-error">{ui('This DSH cannot be restarted from here: {reason}', { reason: status.reason ?? '' })}</p>}
      {status?.supported && busy === 0 && <p>{ui('Nothing is running. DSH quits, starts again by itself, and this page reconnects.')}</p>}
      {status?.supported && busy > 0 && <>
        <p>{ui('Running now; Restart now stops it:')}</p>
        <ul className="dm-list">
          {status.busy.sessions.map(session => <li key={session.id}>{session.title || ui('Untitled conversation')}</li>)}
          {status.busy.jobs.map(job => <li key={job.id}>{job.label}</li>)}
        </ul>
        <p className="dm-muted">{ui('Restart when idle waits until all of it has finished.')}</p>
      </>}
      {error && <p className="dm-error">{error}</p>}
    </div>
  </Modal>;
}

/**
 * Follows the restart of the machine on screen: rarely while nothing happens, every 1.5 s while one is in progress,
 * and reloads the page once a new DSH process marked it back.
 */
export function watchRestart(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let following: string | undefined;
  const tick = async () => {
    const status = await loadRestart();
    if (stopped) return;
    const record = status?.record;
    if (isActive(record)) following = record!.id;
    else if (following && record?.id === following && record.phase === 'back' && record.toPid === status!.pid) {
      try { sessionStorage.setItem(`dsh-machines:back:${following}`, '1'); } catch { /* shown again then */ }
      location.reload();
      return;
    } else if (following && status && record?.id !== following) following = undefined;
    timer = setTimeout(() => void tick(), following ? 1_500 : 60_000);
  };
  void tick();
  const kick = () => { clearTimeout(timer); void tick(); };
  window.addEventListener('dsh-machines:restart', kick);
  return () => { stopped = true; clearTimeout(timer); window.removeEventListener('dsh-machines:restart', kick); };
}

const PHASES: Record<string, string> = { armed: 'Asking DSH to quit…', quitting: 'Waiting for DSH to quit…', launching: 'Starting DSH again…' };

export function RestartOverlay() {
  useLocale();
  const restart = useStore(state => state.restart);
  const unreachable = useStore(state => state.restartUnreachable);
  const [dismissed, setDismissed] = useState('');
  const record = restart?.record;
  const name = machineName(onScreen());
  if (record && record.phase === 'waiting') {
    return <div className="dm-banner" role="status">
      <span>{ui('DSH on {name} restarts once the running work finishes.', { name })}</span>
      <Button size="sm" variant="outline" onClick={() => void requestRestart('now').catch(() => undefined)}>{ui('Restart now')}</Button>
      <Button size="sm" variant="ghost" onClick={() => void requestRestart('cancel').catch(() => undefined)}>{ui('Cancel')}</Button>
    </div>;
  }
  // The last status read stays while the machine does not answer: a restart in progress keeps its cover.
  if (record && isActive(record)) {
    return <div className="dm-cover" role="alert" aria-live="assertive">
      <div className="dm-cover-card">
        <div className="dm-spinner" aria-hidden />
        <strong>{ui('Restarting DSH on {name}', { name })}</strong>
        <span className="dm-muted">{unreachable ? ui('Waiting for it to come back…') : ui(PHASES[record.phase] ?? 'Restarting…')}</span>
      </div>
    </div>;
  }
  if (record?.phase === 'failed' && dismissed !== record.id && Date.now() - record.requestedAt < 10 * 60 * 1000) {
    return <div className="dm-banner" data-tone="error" role="alert">
      <span>{ui('Restarting DSH on {name} failed: {error}', { name, error: record.error ?? '' })} <span className="dm-muted">{record.log}</span></span>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(record.id)}>{ui('Dismiss')}</Button>
    </div>;
  }
  if (record?.phase === 'back' && dismissed !== record.id && record.backAt && Date.now() - record.backAt < 2 * 60 * 1000 && seenBack(record.id)) {
    const changes = (record.changes ?? []).map(change => `${change.name} ${change.from ?? '–'} → ${change.to ?? '–'}`).join(', ');
    return <div className="dm-banner" data-tone="success" role="status">
      <span>{ui('DSH on {name} is back.', { name })}{changes && <> <span className="dm-muted">{changes}</span></>}</span>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(record.id)}>{ui('Dismiss')}</Button>
    </div>;
  }
  return null;
}

/** The page that followed a restart shows "back" once. */
function seenBack(id: string): boolean {
  try { return sessionStorage.getItem(`dsh-machines:back:${id}`) === '1'; } catch { return false; }
}
