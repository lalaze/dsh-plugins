import React, { useEffect, useRef, useState } from 'react';
import type { Agent, Host, Task, TaskDetail } from '../domain.js';
import { api, ApiError, newRequestId, readLocal, saveLocal } from './api.js';
import { emptyTimeline, mergeTimeline, timelineRows } from './timeline.js';
import { PermissionCard } from './permission.js';
import { localizeError, ui } from './i18n.js';
import { ANTIGRAVITY_NOTICE } from '../antigravity.js';

interface PendingMessage { taskId: string; id: string; text: string }
export function TaskView({ task: original, host, update }: { task: Task; host?: Host; update: (task: Task) => void }) {
  const [task, setTask] = useState(original), [agent, setAgent] = useState<Agent | null>(null);
  const [timeline, setTimeline] = useState(emptyTimeline), timelineRef = useRef(timeline);
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [followup, setFollowup] = useState('');
  const [pending, setPending] = useState(() => readLocal<PendingMessage>(`message.${original.id}`));
  const [refresh, setRefresh] = useState(0), reading = useRef(false), output = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const accept = (detail: TaskDetail, older = false) => {
    if (!alive.current) return;
    const stick = output.current ? output.current.scrollHeight - output.current.scrollTop - output.current.clientHeight < 80 : true;
    setTask(detail.task); update(detail.task); setAgent(detail.agent); setError('');
    if (detail.timeline) {
      timelineRef.current = mergeTimeline(timelineRef.current, detail.timeline, older); setTimeline(timelineRef.current);
      if (!older && stick) requestAnimationFrame(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight; });
    }
  };
  useEffect(() => {
    const controller = new AbortController(); let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      let delay = 1200;
      if (!reading.current && !document.hidden) {
        reading.current = true;
        try {
          const cursor = timelineRef.current.endCursor ?? undefined;
          let detail = await api<TaskDetail>('task', { taskId: original.id, cursor, direction: cursor ? 'after' : 'before' }, controller.signal);
          if (cursor && detail.timeline && (detail.timeline.reset || detail.timeline.staleCursor || detail.timeline.gap)) {
            detail = await api<TaskDetail>('task', { taskId: original.id }, controller.signal);
            if (detail.timeline) detail.timeline.reset = true;
          }
          if (!stopped) { accept(detail); if (detail.timeline?.hasNewer) delay = 0; }
        } catch (e) { if (!stopped) { setError(localizeError(e)); delay = 5000; } }
        finally { reading.current = false; }
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [original.id, refresh]);
  const run = async (action: string, operation: () => Promise<void>) => {
    setBusy(action); setError('');
    try { await operation(); if (alive.current) setRefresh(n => n + 1); }
    catch (e) { if (alive.current) setError(localizeError(e)); }
    finally { if (alive.current) setBusy(''); }
  };
  const clearPending = () => { saveLocal(`message.${task.id}`, undefined); if (alive.current) setPending(undefined); };
  const send = (message: PendingMessage) => run('send', async () => {
    let next: Task;
    try { next = await api<Task>('send', { taskId: task.id, message: { id: message.id, text: message.text } }); }
    catch (error) {
      if (error instanceof ApiError && error.rejected) { clearPending(); if (alive.current) setFollowup(message.text); }
      throw error;
    }
    clearPending();
    if (alive.current) { setTask(next); update(next); setFollowup(''); }
  });
  const running = !!agent && (agent.status === 'running' || agent.status === 'initializing' || !!agent.activeTurn || !!agent.pendingPermissions.length);
  const rows = timelineRows(timeline.entries);
  return <section aria-label={task.title}>
    <div className="ra-task-head"><div><h3>{task.title}</h3><div className="ra-address ra-muted">{host?.label} · {task.provider} / {task.model}<br />{task.executionCwd ?? task.cwd}</div></div><div className="ra-actions"><span className="ra-badge" data-status={agent?.status ?? task.state}>{ui(agent?.pendingPermissions.length ? 'Awaiting a response' : agent?.status ?? task.state)}</span><button disabled={!!busy || !task.agentId || !running} className="ra-danger" onClick={() => void run('stop', async () => { await api('stop', { taskId: task.id }); })}>{ui(busy === 'stop' ? 'Stopping…' : 'Stop task')}</button><button disabled={!!busy || !agent || running || agent.status === 'closed'} onClick={() => void run('disconnect', async () => { await api('disconnect', { taskId: task.id }); })}>{ui('Disconnect session')}</button></div></div>
    {error && <div className="ra-notice" role="alert">{error}<button style={{ marginLeft: 8 }} onClick={() => setRefresh(n => n + 1)}>{ui('Refresh')}</button></div>}
    {(!task.agentId || agent?.status === 'closed' || agent?.status === 'error') && <div className="ra-notice"><p>{ui(task.agentId ? 'Reconnect the saved CLI session. Previous instructions will not be replayed.' : 'Task creation is unconfirmed. Recovering reuses the original request ID.')}</p>{task.error && <p>{task.error}</p>}<button disabled={!!busy} onClick={() => void run('retry', async () => { const next = await api<Task>('retry', { taskId: task.id }); if (alive.current) { setTask(next); update(next); } })}>{ui(task.agentId ? 'Reconnect session' : 'Recover task')}</button></div>}
    {task.native?.initialSent && !task.native.initialConfirmed && <div className="ra-notice">{ui('Delivery is unconfirmed. Check task output before sending the same instructions again.')}</div>}
    {agent?.lastError && <div className="ra-notice" role="alert">{agent.lastError}</div>}
    {agent?.resumable === false && <p className="ra-notice">{ui('This CLI did not advertise session recovery. Disconnecting may prevent further messages; saved output will remain available.')}</p>}
    {task.provider === 'antigravity' && <p className="ra-notice">{ui(ANTIGRAVITY_NOTICE)}</p>}
    {agent?.pendingPermissions.map(permission => <PermissionCard key={permission.id} permission={permission} busy={!!busy} respond={answer => void run('respond', async () => { await api('respond', { taskId: task.id, requestId: permission.id, answer }); })} />)}
    <div className="ra-output" aria-label={ui('Task output')} ref={output}>
      {timeline.hasOlder && <button disabled={reading.current || !!busy} onClick={() => void run('older', async () => {
        if (reading.current) return;
        reading.current = true;
        try { const detail = await api<TaskDetail>('task', { taskId: task.id, cursor: timelineRef.current.startCursor, direction: 'before' }); accept(detail, true); }
        finally { reading.current = false; }
      })}>{ui('Load earlier messages')}</button>}
      {rows.length ? rows.map(row => <article key={row.key} className="ra-message" data-kind={row.kind}>
        {row.kind === 'tool_call' ? <details className="ra-tool"><summary>{row.text} · {row.status}</summary><pre>{row.detail}</pre></details> : <><small>{ui(row.kind === 'user_message' ? 'You' : row.kind === 'assistant_message' ? 'Agent' : row.kind === 'reasoning' ? 'Reasoning' : row.kind === 'error' ? 'Remote error' : row.kind)}</small><pre>{row.text}</pre></>}
      </article>) : <div className="ra-empty" role="status">{ui('Waiting for output…')}</div>}
    </div>
    {task.submissions.filter(s => s.state !== 'accepted').map(s => <div className="ra-notice" key={s.id}><p>{ui('Delivery is unconfirmed. Check task output before sending the same instructions again.')}</p><p className="ra-muted">{s.text}</p></div>)}
    {pending?.taskId === task.id && <div className="ra-notice"><p>{ui('Delivery is unconfirmed. Check task output before sending the same instructions again.')}</p><div className="ra-actions"><button disabled={!!busy} onClick={() => void send(pending)}>{ui('Check delivery')}</button><button disabled={!!busy} onClick={() => { setFollowup(pending.text); clearPending(); setError(''); }}>{ui('Discard saved message')}</button></div><p className="ra-foot">{ui('Discarding clears only this saved message. Check task output before sending it again.')}</p></div>}
    <form onSubmit={event => {
      event.preventDefault(); if (!followup.trim() || running || pending) return;
      const message = { taskId: task.id, id: newRequestId(), text: followup.trim() };
      saveLocal(`message.${task.id}`, message); setPending(message); void send(message);
    }}>
      <label className="ra-field">{ui('Follow-up instructions')}<textarea aria-label={ui('Follow-up instructions')} maxLength={100_000} value={followup} onChange={event => setFollowup(event.target.value)} disabled={!!busy || !task.agentId || !!pending} rows={3} /></label>
      <div className="ra-actions" style={{ marginTop: 10 }}><button className="ra-primary" disabled={!!busy || !followup.trim() || !agent || agent.status !== 'idle' || running || !!pending}>{ui('Send follow-up')}</button>{running && <span className="ra-muted">{ui('Send after the task finishes or has been stopped.')}</span>}</div>
    </form>
    {agent?.nativeSessionId && <div className="ra-address ra-muted">{ui('Native session')}: {agent.nativeSessionId}</div>}
    <p className="ra-foot">{ui('Output refreshes automatically. Closing this panel leaves remote tasks running.')}</p>
  </section>;
}
