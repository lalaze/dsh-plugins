import React, { useCallback, useEffect, useRef, useState } from 'react';
import { busy as isWorking, PROVIDER_LABELS, type AgentDetail, type AgentSummary, type ChatProject, type Dashboard, type Host, type PermissionAnswer, type TaskInput } from '../domain.js';
import { api, ApiError } from './api.js';
import { localizeError, ui, useLocale } from './i18n.js';
import { PermissionCard } from './permission.js';
import { emptyTimeline, mergeTimeline, timelineRows } from './timeline.js';

export function useDashboard() {
  const [dashboard, setDashboard] = useState<Dashboard>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Dashboard>(undefined, {}, controller.signal);
        if (!controller.signal.aborted) { setDashboard(next); setError(''); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  return { dashboard, error, refresh };
}

export const statusLabel = (agent: AgentSummary) => ui(agent.archived ? 'Archived' : agent.status === 'attention' ? 'Awaiting a response' : agent.status === 'idle' ? 'Ready' : agent.status);
export function Sessions({ openChat, cwd }: { openChat?: (id: string) => void; cwd?: string }) {
  useLocale();
  const { dashboard, error, refresh } = useDashboard();
  const [selected, setSelected] = useState<string>(), [query, setQuery] = useState(''), [filter, setFilter] = useState('active'), [creating, setCreating] = useState(false);
  const agents = (dashboard?.agents ?? []).filter(a => !a.chatSessionId?.startsWith('remote-compaction-'));
  const matches = agents.filter(a => (filter === 'archived' ? a.archived : !a.archived && (filter !== 'attention' || a.status === 'attention'))
    && `${a.title} ${a.cwd} ${PROVIDER_LABELS[a.provider] ?? a.provider} ${dashboard?.hosts.find(h => h.id === a.hostId)?.label}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.status === 'attention') - Number(a.status === 'attention') || b.updatedAt.localeCompare(a.updatedAt));
  const agent = agents.find(a => a.id === selected);
  return <div className="ra-sessions" data-detail={!!selected || creating}>
    <aside className="ra-session-list" aria-label={ui('Remote sessions')}>
      <div className="ra-list-heading"><div><h2>{ui('Remote sessions')}</h2><p className="ra-muted">{ui('Your agents, in one place.')}</p></div><button className="ra-primary" onClick={() => { setSelected(undefined); setCreating(true); }}>{ui('New session')}</button></div>
      <input aria-label={ui('Search sessions')} placeholder={ui('Search sessions')} value={query} onChange={e => setQuery(e.target.value)} />
      <div className="ra-filters" role="group" aria-label={ui('Filter sessions')}>{[['active', 'All sessions'], ['attention', 'Needs attention'], ['archived', 'Archived']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{ui(label)}{id === 'attention' && agents.some(a => !a.archived && a.pendingPermissions > 0) ? ` (${agents.filter(a => !a.archived && a.pendingPermissions > 0).length})` : ''}</button>)}</div>
      {error && <div role="alert" className="ra-banner" data-tone="error">{localizeError(error)}<button onClick={refresh}>{ui('Retry')}</button></div>}
      <div className="ra-session-items">{matches.map(a => <button className="ra-session-item" key={a.id} data-agent-id={a.id} aria-current={selected === a.id ? 'true' : undefined} onClick={() => { setSelected(a.id); setCreating(false); }}>
        <span className="ra-session-title">{a.title}</span><span className="ra-session-meta">{PROVIDER_LABELS[a.provider] ?? a.provider} · {dashboard?.hosts.find(h => h.id === a.hostId)?.label}</span>
        <span className="ra-session-path" title={a.cwd}>{a.cwd}</span><span className="ra-session-meta"><span className="ra-badge" data-status={a.status}>{statusLabel(a)}</span><span>{ui(a.chatSessionId ? 'Main chat' : a.delegated ? 'Delegated' : 'Remote session')}</span></span>
      </button>)}{!matches.length && <div className="ra-empty">{ui(dashboard ? 'No matching sessions.' : 'Loading sessions…')}</div>}</div>
    </aside>
    <main className="ra-session-main"><button className="ra-back" onClick={() => { setSelected(undefined); setCreating(false); }}>{ui('Back to sessions')}</button>
      {creating ? <NewSession cwd={cwd} created={a => { setSelected(a.id); setCreating(false); refresh(); }} />
        : agent ? <SessionDetail key={agent.id} original={agent} host={dashboard?.hosts.find(h => h.id === agent.hostId)} changed={refresh} openChat={openChat} />
        : <div className="ra-welcome"><span className="ra-welcome-icon" aria-hidden="true">↗</span><h2>{ui('Pick up where you left off')}</h2><p className="ra-muted">{ui('Choose a session to read its history, respond to approvals, or continue working.')}</p><button onClick={() => setCreating(true)}>{ui('New session')}</button></div>}
    </main>
  </div>;
}

function NewSession({ cwd, created }: { cwd?: string; created: (agent: AgentSummary) => void }) {
  const [projects, setProjects] = useState<ChatProject[]>(), [projectId, setProjectId] = useState(''), [providerId, setProviderId] = useState(''), [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState(''), [error, setError] = useState(''), [sending, setSending] = useState(false), [pending, setPending] = useState<TaskInput>();
  useEffect(() => { const c = new AbortController(); void api<ChatProject[]>('hostCatalogs', {}, c.signal).then(p => { if (!c.signal.aborted) { setProjects(p); setProjectId(p[0]?.id ?? ''); } }).catch(e => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }); return () => c.abort(); }, []);
  const project = projects?.find(p => p.id === projectId), providers = project?.providers.filter(p => p.status === 'ready' && p.models.length) ?? [];
  const provider = providers.find(p => p.id === providerId) ?? providers[0], model = provider?.models.find(m => m.id === modelId) ?? provider?.models.find(m => m.isDefault) ?? provider?.models[0];
  const submit = async () => {
    if (!project || !provider || !model || !cwd || !prompt.trim() || sending) return;
    const request = pending ?? { id: crypto.randomUUID(), hostId: project.hostId, cwd, provider: provider.id, model: model.id, prompt: prompt.trim(), ...(provider.defaultModeId ? { modeId: provider.defaultModeId } : {}), ...(model.defaultThinkingOptionId ? { thinkingOptionId: model.defaultThinkingOptionId } : {}) };
    setPending(request); setSending(true); setError('');
    try { created(await api<AgentSummary>('create', { agent: request })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof ApiError && e.status < 500) setPending(undefined); }
    finally { setSending(false); }
  };
  return <form className="ra-new-session" onSubmit={e => { e.preventDefault(); void submit(); }}><h2>{ui('New remote session')}</h2><p className="ra-muted">{ui('Choose a machine and an agent. The current DSH workspace path is used on that machine.')}</p>
    {error && <div className="ra-banner" role="alert" data-tone="error">{localizeError(error)}</div>}
    {projects?.length === 0 ? <p className="ra-banner">{ui('Add a machine or refresh its models in Settings → Remote agents.')}</p> : <>
      <label className="ra-field">{ui('Host')}<select aria-label={ui('Session host')} value={projectId} disabled={sending || !!pending} onChange={e => { setProjectId(e.target.value); setProviderId(''); setModelId(''); }}>{projects?.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      {cwd ? <p className="ra-mono ra-muted">{cwd}</p> : <p className="ra-banner">{ui('Choose a DSH workspace before starting a remote CLI conversation.')}</p>}
      <div className="ra-grid"><label className="ra-field">{ui('Agent')}<select aria-label={ui('Session agent')} value={provider?.id ?? ''} disabled={sending || !!pending} onChange={e => { setProviderId(e.target.value); setModelId(''); }}>{providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label className="ra-field">{ui('Model')}<select aria-label={ui('Session model')} value={model?.id ?? ''} disabled={sending || !!pending} onChange={e => setModelId(e.target.value)}>{provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label></div>
      {provider?.notice && <p className="ra-banner">{ui(provider.notice)}</p>}
      <label className="ra-field">{ui('Task')}<textarea aria-label={ui('Task')} rows={5} maxLength={100_000} required value={prompt} disabled={sending || !!pending} onChange={e => setPrompt(e.target.value)} placeholder={ui('What would you like the agent to do?')} /></label>
      <button className="ra-primary" disabled={!cwd || !model || !prompt.trim() || sending}>{ui(sending ? 'Starting…' : pending ? 'Check creation' : 'Start session')}</button>
      {pending && !sending && <p className="ra-muted">{ui('Retry checks the same request. It will not create another agent.')}</p>}
    </>}
  </form>;
}

interface PendingMessage { id: string; text: string }
function savedMessage(id: string): PendingMessage | undefined {
  try { const value = JSON.parse(sessionStorage.getItem(`remote-message:${id}`) ?? 'null'); if (typeof value?.id === 'string' && typeof value?.text === 'string') return value; } catch {}
}
function SessionDetail({ original, host, changed, openChat }: { original: AgentSummary; host?: Host; changed: () => void; openChat?: (id: string) => void }) {
  const [detail, setDetail] = useState<AgentDetail>(), [timeline, setTimeline] = useState(emptyTimeline), timelineRef = useRef(timeline);
  const [error, setError] = useState(''), [working, setWorking] = useState(false), [revision, setRevision] = useState(0), [draft, setDraft] = useState(''), [pending, setPending] = useState(() => savedMessage(original.id));
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(original.title);
  const output = useRef<HTMLDivElement>(null), reading = useRef(false), alive = useRef(true), followOutput = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const accept = (next: AgentDetail, older = false) => {
    if (!alive.current) return;
    const el = output.current, stick = followOutput.current || !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80, height = el?.scrollHeight ?? 0;
    setDetail(next);
    if (next.timeline) { timelineRef.current = mergeTimeline(timelineRef.current, next.timeline, older); setTimeline(timelineRef.current); }
    requestAnimationFrame(() => { if (alive.current && output.current) { if (older) output.current.scrollTop += output.current.scrollHeight - height; else if (stick) { output.current.scrollTop = output.current.scrollHeight; followOutput.current = false; } } });
  };
  useEffect(() => {
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 750;
      if (!reading.current) {
        reading.current = true;
        try {
          const cursor = timelineRef.current.endCursor;
          const next = await api<AgentDetail>('agent', { agentId: original.id, ...(cursor ? { cursor, direction: 'after' } : {}) }, c.signal);
          if (!c.signal.aborted) { accept(next); if (next.timeline?.hasNewer) delay = 0; }
        } catch (e) { if (!c.signal.aborted) setError(e instanceof Error ? e.message : String(e)); delay = 3000; }
        finally { reading.current = false; }
      }
      if (!c.signal.aborted) timer = setTimeout(() => void poll(), delay);
    };
    void poll(); return () => { c.abort(); clearTimeout(timer); };
  }, [original.id, revision]);
  const run = async (operation: () => Promise<void>) => {
    if (working) return; setWorking(true); setError('');
    try { await operation(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (alive.current) { setWorking(false); setRevision(n => n + 1); changed(); } }
  };
  const savePending = (message?: PendingMessage) => {
    try { if (message) sessionStorage.setItem(`remote-message:${original.id}`, JSON.stringify(message)); else sessionStorage.removeItem(`remote-message:${original.id}`); } catch {}
    if (alive.current) setPending(message);
  };
  const send = () => run(async () => {
    followOutput.current = true;
    const message = pending ?? { id: crypto.randomUUID(), text: draft.trim() }; savePending(message);
    try { await api('send', { agentId: original.id, message }); savePending(); if (alive.current) setDraft(''); }
    catch (e) { if (e instanceof ApiError && e.status < 500) { savePending(); if (alive.current) setDraft(message.text); } throw e; }
  });
  const agent = detail?.agent ?? original, running = isWorking(agent);
  const respond = (requestId: string, answer: PermissionAnswer) => run(async () => { await api('respond', { agentId: agent.id, requestId, answer }); });
  return <section className="ra-session-detail" aria-label={agent.title}>
    <header className="ra-detail-heading"><div><h2>{agent.title}</h2><p className="ra-muted">{PROVIDER_LABELS[agent.provider] ?? agent.provider} · {agent.model} · {host?.label}</p><p className="ra-mono ra-muted">{agent.cwd}</p></div><span className="ra-badge" data-status={agent.status}>{statusLabel(agent)}</span></header>
    <div className="ra-detail-actions"><button disabled={working || !running} onClick={() => void run(async () => { await api('stop', { agentId: agent.id }); })}>{ui('Stop')}</button><button disabled={working || running} onClick={() => void run(async () => { await api('archive', { agentId: agent.id, archived: !agent.archived }); })}>{ui(agent.archived ? 'Restore' : 'Archive')}</button><button disabled={working} onClick={() => { setTitle(agent.title); setRenaming(!renaming); }}>{ui('Rename')}</button>{agent.chatSessionId && <button className="ra-primary" onClick={() => void run(async () => { if (!openChat) throw new Error('Open this conversation from the DSH sidebar.'); openChat(agent.chatSessionId!); })}>{ui('Open in main chat')}</button>}</div>
    {renaming && <form className="ra-rename" onSubmit={e => { e.preventDefault(); void run(async () => { await api('rename', { agentId: agent.id, title }); setRenaming(false); }); }}><input aria-label={ui('Session title')} value={title} maxLength={100} required onChange={e => setTitle(e.target.value)} /><button disabled={working || !title.trim()}>{ui('Save')}</button></form>}
    {error && <div className="ra-banner" data-tone="error" role="alert">{localizeError(error)}<button onClick={() => { setError(''); setRevision(n => n + 1); }}>{ui('Refresh')}</button></div>}
    {agent.error && <p className="ra-banner" data-tone="error">{localizeError(agent.error)}</p>}
    {!agent.started && <button disabled={working} onClick={() => void run(async () => { await api('retry', { agentId: agent.id }); })}>{ui('Retry starting session')}</button>}
    <div className="ra-permissions">{detail?.permissions.map(p => <PermissionCard key={p.id} permission={p} busy={working} respond={answer => void respond(p.id, answer)} />)}</div>
    <div className="ra-output" aria-label={ui('Session history')} ref={output}>
      {timeline.hasOlder && <button disabled={working} onClick={() => void run(async () => {
        // Older and live pages merge by sequence. A live refresh must never swallow this click.
        accept(await api<AgentDetail>('agent', { agentId: agent.id, cursor: timelineRef.current.startCursor, direction: 'before' }), true);
      })}>{ui('Load earlier messages')}</button>}
      {timelineRows(timeline.entries).map(row => <article className="ra-message" key={row.key} data-kind={row.kind}>{row.kind === 'tool_call' ? <details className="ra-tool"><summary>{row.text}<span className="ra-muted">{ui(row.status ?? '')}</span></summary><pre>{row.detail}</pre></details> : row.kind === 'reasoning' ? <details className="ra-thinking"><summary>{ui('Reasoning')}</summary><pre>{row.text}</pre></details> : <><small>{ui(row.kind === 'user_message' ? 'You' : row.kind === 'assistant_message' ? 'Agent' : row.kind === 'error' ? 'Remote error' : 'Interrupted')}</small><pre>{row.kind === 'interrupted' ? ui('This turn was stopped.') : row.text}</pre>{row.status === 'unconfirmed' && <span className="ra-muted">{ui('Message delivery is not confirmed.')}</span>}</>}</article>)}
      {!timeline.entries.length && <div className="ra-empty">{ui('Waiting for output…')}</div>}
    </div>
    {agent.chatSessionId ? <p className="ra-compose-note">{ui('Continue in the main chat. Pending approvals can also be answered here.')}</p> : <form className="ra-compose" onSubmit={e => { e.preventDefault(); if (!running && (pending || draft.trim())) void send(); }}>
      {pending && <p className="ra-banner">{ui('Delivery is unconfirmed. Check the same message before sending another.')}</p>}
      <textarea aria-label={ui('Message the agent')} placeholder={ui('Message the agent')} rows={2} maxLength={100_000} value={pending?.text ?? draft} disabled={working || !!pending || !agent.started || agent.status === 'closed'} onChange={e => setDraft(e.target.value)} />
      <div className="ra-compose-actions"><span className="ra-muted">{ui(running ? 'Wait for this turn, or stop it before sending.' : 'Messages continue the saved remote session.')}</span><button className="ra-primary" disabled={working || (!draft.trim() && !pending) || !agent.started || agent.status === 'closed' || running}>{ui(pending ? 'Check delivery' : 'Send')}</button></div>
    </form>}
  </section>;
}
