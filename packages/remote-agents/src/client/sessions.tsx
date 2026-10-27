import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { busy as isWorking, permissionModes, PROVIDER_LABELS, type AgentDetail, type AgentSummary, type ChatProject, type Dashboard, type Host, type PermissionAnswer, type TaskInput } from '../domain.js';
import { api, ApiError, requestId } from './api.js';
import { formatLocale, localizeError, ui, useLocale } from './i18n.js';
import { PermissionCard } from './permission.js';
import { emptyTimeline, mergeTimeline, timelineRows, type TimelineRow } from './timeline.js';
import Markdown from 'react-markdown';
import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { NotePencilIcon } from '@phosphor-icons/react/dist/csr/NotePencil';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { needsAttention, projectName, sessionPriority, sessionView, visibleSession, type SessionView } from './session-list.js';

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
function SessionTime({ value }: { value: string }) {
  const date = new Date(value), now = Date.now(), minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (!Number.isFinite(date.getTime())) return null;
  const text = minutes < 1 ? ui('Just now') : minutes < 60 ? ui('{count}m ago', { count: minutes })
    : minutes < 1440 ? ui('{count}h ago', { count: Math.floor(minutes / 60) })
    : new Intl.DateTimeFormat(formatLocale(), { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}) }).format(date);
  return <time dateTime={value} title={date.toLocaleString(formatLocale())}>{text}</time>;
}
function dayLabel(value: string): string {
  const today = new Date(), date = new Date(value); today.setHours(0, 0, 0, 0);
  if (date >= today) return 'Today';
  today.setDate(today.getDate() - 1);
  return date >= today ? 'Yesterday' : 'Earlier';
}
export function Sessions({ openChat, cwd }: { openChat?: (id: string) => void; cwd?: string }) {
  useLocale();
  const { dashboard, error, refresh } = useDashboard();
  const [selected, setSelected] = useState<string>(), [query, setQuery] = useState(''), [filter, setFilter] = useState<SessionView>('active'), [creating, setCreating] = useState(false), [showDetail, setShowDetail] = useState(false);
  const [archiving, setArchiving] = useState(false), [actionError, setActionError] = useState(''), [notice, setNotice] = useState('');
  const agents = (dashboard?.agents ?? []).filter(visibleSession);
  const activeCount = agents.filter(a => sessionView(a) === 'active').length, archivedCount = agents.filter(a => a.archived).length;
  const hostLabel = (a: AgentSummary) => dashboard?.hosts.find(h => h.id === a.hostId)?.label ?? a.hostId;
  const matches = agents.filter(a => sessionView(a) === filter
    && `${a.title} ${a.cwd} ${PROVIDER_LABELS[a.provider] ?? a.provider} ${hostLabel(a)}`.toLowerCase().includes(query.trim().toLowerCase())).sort(sessionPriority);
  const agent = agents.find(a => a.id === selected);
  // Open the first result on desktop; the mobile list stays visible until a row is tapped.
  const firstId = matches[0]?.id;
  useEffect(() => { if (!selected && !creating && firstId) setSelected(firstId); }, [selected, creating, firstId]);
  const groups = new Map<string, AgentSummary[]>();
  for (const item of matches) { const label = filter === 'active' && needsAttention(item) ? 'Needs attention' : dayLabel(item.updatedAt); groups.set(label, [...(groups.get(label) ?? []), item]); }
  const choose = (id: string) => { setSelected(id); setCreating(false); setShowDetail(true); };
  const newSession = () => { setSelected(undefined); setCreating(true); setShowDetail(true); };
  const switchView = (view: SessionView) => { setFilter(view); setQuery(''); setSelected(undefined); setCreating(false); setShowDetail(false); setNotice(''); setActionError(''); };
  const archiveHistory = async () => {
    if (archiving) return;
    const ids = matches.filter(a => sessionView(a) === 'history').map(a => a.id);
    setArchiving(true); setActionError(''); setNotice('');
    let archived = 0, failed = 0;
    for (const id of ids) {
      try { await api('archive', { agentId: id, onlyIdle: true }); archived++; }
      catch { failed++; }
    }
    setArchiving(false); refresh();
    if (archived) setNotice(ui('{count} sessions archived. Restore them from Archived.', { count: archived }));
    if (failed) setActionError(ui('{count} sessions could not be archived. They may be active or offline. Refresh and try again.', { count: failed }));
  };
  return <div className="ra-sessions" data-detail={showDetail || creating}>
    <aside className="ra-session-list" aria-label={ui('Remote sessions')}>
      <div className="ra-list-heading"><h2>{ui('Sessions')}</h2><button className="ra-icon-button" aria-label={ui('New session')} title={ui('New session')} onClick={newSession}><NotePencilIcon size={22} /></button></div>
      <label className="ra-session-search"><MagnifyingGlassIcon size={18} /><input aria-label={ui('Search sessions')} placeholder={ui('Search sessions')} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="ra-filters" role="group" aria-label={ui('Filter sessions')}><button aria-pressed={filter === 'active'} onClick={() => switchView('active')}>{ui('In progress')}{activeCount > 0 && <span>{activeCount}</span>}</button><button aria-pressed={filter === 'history'} onClick={() => switchView('history')}>{ui('History')}</button>{filter === 'archived' && <button aria-pressed="true" onClick={() => switchView('archived')}>{ui('Archived')}</button>}</div>
      {(error || actionError) && <div role="alert" className="ra-banner" data-tone="error">{actionError || localizeError(error)}<button onClick={() => { setActionError(''); refresh(); }}>{ui('Retry')}</button></div>}
      {notice && <p className="ra-session-notice" role="status">{notice}</p>}
      <div className="ra-session-items" aria-busy={!dashboard}>{[...groups].map(([label, items]) => <section className="ra-session-group" key={label}><h3>{ui(label)}</h3>{items.map(a => <button className="ra-session-item" key={a.id} data-agent-id={a.id} aria-current={selected === a.id ? 'true' : undefined} onClick={() => choose(a.id)}>
        <span className="ra-session-topline"><span className="ra-session-title"><span>{a.title}</span>{(needsAttention(a) || isWorking(a)) && <CircleIcon className="ra-session-dot" data-status={a.status} size={8} weight="fill" aria-label={statusLabel(a)} />}</span><SessionTime value={a.updatedAt} /></span>
        <span className="ra-session-meta" title={`${PROVIDER_LABELS[a.provider] ?? a.provider} · ${hostLabel(a)} · ${a.cwd}`}>{PROVIDER_LABELS[a.provider] ?? a.provider} · {hostLabel(a)} / {projectName(a.cwd)}</span>{a.reconnecting && <span className="ra-badge" data-status="connecting">{ui('Reconnecting')}</span>}
      </button>)}</section>)}{!matches.length && <div className="ra-list-empty"><h3>{ui(!dashboard ? 'Loading sessions…' : query ? 'No matching sessions.' : filter === 'active' ? 'All caught up' : filter === 'history' ? 'No saved sessions yet' : 'No archived sessions')}</h3><p>{ui(query ? 'Try a task name, project or host.' : filter === 'active' ? 'Saved sessions are in History. Start something new whenever you are ready.' : filter === 'history' ? 'Your completed turns will appear here, ready to continue.' : 'Archive a saved session to keep your history tidy.')}</p>{dashboard && filter === 'active' && !query && <button onClick={() => switchView('history')}>{ui('Browse history')}</button>}</div>}</div>
      <footer className="ra-list-footer">{filter === 'history' && matches.length > 0 && <button className="ra-bulk-archive" disabled={archiving} onClick={() => void archiveHistory()}>{ui(archiving ? 'Archiving…' : 'Archive listed history')}</button>}<button className="ra-archive-link" aria-pressed={filter === 'archived'} onClick={() => switchView('archived')}><ArchiveIcon size={19} /><span>{ui('Archived sessions')}</span>{archivedCount > 0 && <small>{archivedCount}</small>}<CaretRightIcon size={15} /></button></footer>
    </aside>
    <main className="ra-session-main"><button className="ra-back" onClick={() => { setShowDetail(false); setCreating(false); }}><ArrowLeftIcon size={16} />{ui('Back to sessions')}</button>
      {creating ? <NewSession cwd={cwd} created={a => { choose(a.id); setFilter(sessionView(a)); refresh(); }} />
        : agent ? <SessionDetail key={agent.id} original={agent} host={dashboard?.hosts.find(h => h.id === agent.hostId)} changed={refresh} openChat={openChat} />
        : <div className="ra-selection-empty"><TerminalIcon size={28} weight="light" /><h2>{ui(dashboard ? 'Choose a session' : 'Loading sessions…')}</h2><p>{ui('Select saved work to read its history or continue a task.')}</p><button onClick={newSession}>{ui('New session')}</button></div>}
    </main>
  </div>;
}

function NewSession({ cwd, created }: { cwd?: string; created: (agent: AgentSummary) => void }) {
  const [projects, setProjects] = useState<ChatProject[]>(), [projectId, setProjectId] = useState(''), [providerId, setProviderId] = useState(''), [modelId, setModelId] = useState(''), [selectedMode, setSelectedMode] = useState(''), [speedId, setSpeedId] = useState('');
  const [prompt, setPrompt] = useState(''), [error, setError] = useState(''), [sending, setSending] = useState(false), [pending, setPending] = useState<TaskInput>();
  useEffect(() => { const c = new AbortController(); void api<ChatProject[]>('hostCatalogs', {}, c.signal).then(p => { if (!c.signal.aborted) { setProjects(p); setProjectId(p[0]?.id ?? ''); } }).catch(e => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }); return () => c.abort(); }, []);
  const project = projects?.find(p => p.id === projectId), providers = project?.providers.filter(p => p.status === 'ready' && p.models.length) ?? [];
  const provider = providers.find(p => p.id === providerId) ?? providers[0], model = provider?.models.find(m => m.id === modelId) ?? provider?.models.find(m => m.isDefault) ?? provider?.models[0];
  const modes = provider ? permissionModes(provider.id, provider.modes) : [];
  const modeId = selectedMode || (provider?.id === 'claude' ? 'inherit' : provider?.defaultModeId ?? '');
  const serviceTier = model?.serviceTiers?.find(t => t.id === speedId)?.id;
  const submit = async () => {
    if (!project || !provider || !model || !cwd || !prompt.trim() || sending) return;
    const request = pending ?? { id: requestId(), hostId: project.hostId, cwd, provider: provider.id, model: model.id, prompt: prompt.trim(), ...(modeId ? { modeId } : {}), ...(model.defaultThinkingOptionId ? { thinkingOptionId: model.defaultThinkingOptionId } : {}), ...(serviceTier ? { serviceTier } : {}) };
    setPending(request); setSending(true); setError('');
    try { created(await api<AgentSummary>('create', { agent: request })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof ApiError && e.status < 500) setPending(undefined); }
    finally { setSending(false); }
  };
  return <form className="ra-new-session" onSubmit={e => { e.preventDefault(); void submit(); }}><h2>{ui('New remote session')}</h2><p className="ra-muted">{ui('Choose a machine and an agent. The current DSH workspace path is used on that machine.')}</p>
    {error && <div className="ra-banner" role="alert" data-tone="error">{localizeError(error)}</div>}
    {projects?.length === 0 ? <p className="ra-banner">{ui('Add a machine or refresh its models in Settings → Remote agents.')}</p> : <>
      <label className="ra-field">{ui('Host')}<select aria-label={ui('Session host')} value={projectId} disabled={sending || !!pending} onChange={e => { setProjectId(e.target.value); setProviderId(''); setModelId(''); setSelectedMode(''); setSpeedId(''); }}>{projects?.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      {cwd ? <p className="ra-mono ra-muted">{cwd}</p> : <p className="ra-banner">{ui('Choose a DSH workspace before starting a remote CLI conversation.')}</p>}
      <div className="ra-grid"><label className="ra-field">{ui('Agent')}<select aria-label={ui('Session agent')} value={provider?.id ?? ''} disabled={sending || !!pending} onChange={e => { setProviderId(e.target.value); setModelId(''); setSelectedMode(''); setSpeedId(''); }}>{providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label className="ra-field">{ui('Model')}<select aria-label={ui('Session model')} value={model?.id ?? ''} disabled={sending || !!pending} onChange={e => setModelId(e.target.value)}>{provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label></div>
      {!!model?.serviceTiers?.length && <label className="ra-field">{ui('Speed')}<select aria-label={ui('Session speed')} value={serviceTier ?? ''} disabled={sending || !!pending} onChange={e => setSpeedId(e.target.value)}><option value="">{ui('Remote CLI settings')}</option>{model.serviceTiers.map(t => <option key={t.id} value={t.id}>{ui(t.label)}</option>)}</select><small className="ra-muted">{ui('Faster tiers use more of the remote account’s quota.')}</small></label>}
      {provider?.notice && <p className="ra-banner">{ui(provider.notice)}</p>}
      {modes.length > 0 && <label className="ra-field">{ui('Permission mode')}<select aria-label={ui('Permission mode')} value={modeId} disabled={sending || !!pending} onChange={e => setSelectedMode(e.target.value)}>{!modeId && <option value="">{ui('Remote CLI settings')}</option>}{modes.map(m => <option key={m.id} value={m.id}>{ui(m.label)}</option>)}</select><small className="ra-muted">{ui('Remote permissions are separate from DSH workspace permissions. Full access allows commands and edits without individual approval.')}</small>{provider?.id === 'claude' && <small className="ra-muted">{ui('Claude uses non-interactive CLI settings, which can differ from terminal defaults. Select Auto explicitly to use automatic safety checks.')}</small>}</label>}
      <label className="ra-field">{ui('Task')}<textarea aria-label={ui('Task')} rows={5} maxLength={100_000} required value={prompt} disabled={sending || !!pending} onChange={e => setPrompt(e.target.value)} placeholder={ui('What would you like the agent to do?')} /></label>
      <button className="ra-primary" disabled={!cwd || !model || !prompt.trim() || sending}>{ui(sending ? 'Starting…' : pending ? 'Check creation' : 'Start session')}</button>
      {pending && !sending && <p className="ra-muted">{ui('Retry checks the same request. It will not create another agent.')}</p>}
    </>}
  </form>;
}

/** Codex request IDs of its speed tiers; newer tiers show their ID. */
const SPEED_LABELS: Readonly<Record<string, string>> = { priority: 'Fast', fast: 'Fast', flex: 'Flex' };
interface PendingMessage { id: string; text: string }
function savedMessage(id: string): PendingMessage | undefined {
  try { const value = JSON.parse(sessionStorage.getItem(`remote-message:${id}`) ?? 'null'); if (typeof value?.id === 'string' && typeof value?.text === 'string') return value; } catch {}
}
function SessionDetail({ original, host, changed, openChat }: { original: AgentSummary; host?: Host; changed: () => void; openChat?: (id: string) => void }) {
  const [detail, setDetail] = useState<AgentDetail>(), [timeline, setTimeline] = useState(emptyTimeline), timelineRef = useRef(timeline);
  const [error, setError] = useState(''), [working, setWorking] = useState(false), [revision, setRevision] = useState(0), [draft, setDraft] = useState(''), [pending, setPending] = useState(() => savedMessage(original.id));
  const [renaming, setRenaming] = useState(false), [title, setTitle] = useState(original.title), [optionsOpen, setOptionsOpen] = useState(false);
  const menuId = useId(), menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!optionsOpen) return;
    const pointer = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOptionsOpen(false); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard, true); };
  }, [optionsOpen]);
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
    const message = pending ?? { id: requestId(), text: draft.trim() }; savePending(message);
    try { await api('send', { agentId: original.id, message }); savePending(); if (alive.current) setDraft(''); }
    catch (e) { if (e instanceof ApiError && e.status < 500) { savePending(); if (alive.current) setDraft(message.text); } throw e; }
  });
  const agent = detail?.agent ?? original, running = isWorking(agent), rows = timelineRows(timeline.entries);
  const lastRow = rows.at(-1);
  const turnComplete = agent.status === 'idle' && (lastRow?.kind === 'assistant_message' || (lastRow?.kind === 'tool_call' && lastRow.status === 'completed'));
  const respond = (requestId: string, answer: PermissionAnswer) => run(async () => { await api('respond', { agentId: agent.id, requestId, answer }); });
  return <section className="ra-session-detail" aria-label={agent.title}>
    <header className="ra-detail-heading"><div className="ra-detail-title"><h2>{agent.title}</h2><p title={`${agent.model} · ${agent.cwd}`}>{PROVIDER_LABELS[agent.provider] ?? agent.provider} · {host?.label ?? agent.hostId} / {projectName(agent.cwd)}</p>{agent.persistent && <p className="ra-muted">{ui(agent.reconnecting ? 'The SSH connection was lost. The remote CLI keeps running; reconnecting to catch up on its output.' : 'Runs in a relay on the SSH host and keeps working when DSH closes or SSH disconnects.')}</p>}</div>{agent.reconnecting && <span className="ra-badge" data-status="connecting">{ui('Reconnecting')}</span>}
      <div className="ra-detail-actions">{running && <button disabled={working} onClick={() => void run(async () => { await api('stop', { agentId: agent.id }); })}><PauseIcon size={17} />{ui('Stop')}</button>}<button disabled={working || running} onClick={() => void run(async () => { await api('archive', { agentId: agent.id, archived: !agent.archived }); })}><ArchiveIcon size={18} />{ui(agent.archived ? 'Restore' : 'Archive')}</button>
        <div className="ra-detail-menu" ref={menu}><button className="ra-icon-button" aria-label={ui('Session options')} title={ui('Session options')} aria-expanded={optionsOpen} aria-controls={menuId} onClick={() => setOptionsOpen(!optionsOpen)}><DotsThreeIcon size={24} weight="bold" /></button>
          {optionsOpen && <div className="ra-options-panel" id={menuId} role="group" aria-label={ui('Session options')}><span className="ra-options-status" data-status={agent.status}>{statusLabel(agent)}</span><p className="ra-muted">{agent.model}{agent.serviceTier ? ` · ${ui(SPEED_LABELS[agent.serviceTier] ?? agent.serviceTier)}` : ''}</p><p className="ra-mono ra-muted">{agent.cwd}</p><button disabled={working} onClick={() => { setTitle(agent.title); setRenaming(true); setOptionsOpen(false); }}>{ui('Rename')}</button>
            {agent.modes.length > 0 && <label className="ra-field">{ui('Permission mode')}<select aria-label={ui('Permission mode')} value={agent.modeId ?? (agent.provider === 'claude' ? 'inherit' : '')} disabled={working || running || agent.resumable === false} onChange={e => { const modeId = e.target.value; void run(async () => { await api('mode', { agentId: agent.id, modeId }); }); }}>{!agent.modeId && agent.provider !== 'claude' && <option value="">{ui('Remote CLI settings')}</option>}{agent.modes.map(m => <option key={m.id} value={m.id}>{ui(m.label)}</option>)}</select><small>{ui(running ? 'Stop the agent before changing its mode' : 'Applies to the next message. Full access allows commands and edits without individual approval.')}</small>{agent.provider === 'claude' && <small>{ui('Claude uses non-interactive CLI settings, which can differ from terminal defaults. Select Auto explicitly to use automatic safety checks.')}</small>}</label>}
          </div>}
        </div>
      </div>
    </header>
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
      <Conversation rows={rows} provider={PROVIDER_LABELS[agent.provider] ?? agent.provider} />
      {turnComplete && <p className="ra-turn-status"><CheckCircleIcon size={16} weight="fill" />{ui('Turn complete')}</p>}
      {!timeline.entries.length && <div className="ra-empty">{ui('Waiting for output…')}</div>}
    </div>
    {agent.chatSessionId ? <div className="ra-compose-note"><span>{ui('Continue in the main chat. Pending approvals can also be answered here.')}</span><button className="ra-primary" disabled={working} onClick={() => void run(async () => { if (!openChat) throw new Error('Open this conversation from the DSH sidebar.'); openChat(agent.chatSessionId!); })}>{ui('Open in main chat')}<ArrowSquareOutIcon size={17} /></button></div> : <form className="ra-compose" onSubmit={e => { e.preventDefault(); if (!running && (pending || draft.trim())) void send(); }}>
      {pending && <p className="ra-banner">{ui('Delivery is unconfirmed. Check the same message before sending another.')}</p>}
      <textarea aria-label={ui('Message the agent')} placeholder={ui('Continue this task…')} rows={2} maxLength={100_000} value={pending?.text ?? draft} disabled={working || !!pending || !agent.started || agent.status === 'closed'} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} />
      <div className="ra-compose-actions"><span className="ra-composer-provider">{PROVIDER_LABELS[agent.provider] ?? agent.provider}</span>{running && <span className="ra-compose-wait">{ui('Wait for this turn, or stop it before sending.')}</span>}<button className="ra-primary" disabled={working || (!draft.trim() && !pending) || !agent.started || agent.status === 'closed' || running}><PaperPlaneTiltIcon size={18} />{ui(pending ? 'Check delivery' : 'Send')}</button></div>
    </form>}
  </section>;
}

function Conversation({ rows, provider }: { rows: TimelineRow[]; provider: string }) {
  const blocks: TimelineRow[][] = [];
  for (const row of rows) {
    const last = blocks.at(-1);
    if (row.kind === 'tool_call' && last?.[0].kind === 'tool_call') last.push(row); else blocks.push([row]);
  }
  return <>{blocks.map(block => {
    const row = block[0];
    const heading = row.kind === 'assistant_message' ? /^#{1,3}\s+([^\n]+)\n*/.exec(row.text) : null;
    const body = heading ? row.text.slice(heading[0].length) : row.text;
    if (row.kind === 'tool_call') return <details className="ra-tools-group" key={row.key}><summary><CaretRightIcon size={16} /><TerminalIcon size={17} /><span>{ui('Tool activity · {count}', { count: block.length })}</span><span className="ra-muted">{ui(block.every(r => r.status === 'completed') ? 'completed' : block.some(r => r.status === 'running') ? 'running' : 'Details')}</span></summary>{block.map(tool => <details className="ra-tool" key={tool.key}><summary>{tool.text}<span className="ra-muted">{ui(tool.status ?? '')}</span></summary><pre>{tool.detail}</pre></details>)}</details>;
    if (row.kind === 'reasoning') return <details className="ra-thinking" key={row.key}><summary>{ui('Reasoning')}</summary><pre>{row.text}</pre></details>;
    return <article className="ra-message" key={row.key} data-kind={row.kind}>{row.kind === 'assistant_message' && <span className="ra-agent-avatar" aria-hidden="true">{provider.slice(0, 1)}</span>}<div className="ra-message-content">{row.kind === 'assistant_message' && <div className="ra-message-byline"><strong>{heading?.[1] ?? provider}</strong>{row.timestamp && <SessionTime value={row.timestamp} />}</div>}
      {row.kind === 'assistant_message' ? <div className="ra-markdown"><Markdown>{body}</Markdown></div> : <pre>{row.kind === 'interrupted' ? ui('This turn was stopped.') : row.text}</pre>}
      {row.kind === 'user_message' && row.timestamp && <div className="ra-message-time"><SessionTime value={row.timestamp} /></div>}{row.status === 'unconfirmed' && <span className="ra-muted">{ui('Message delivery is not confirmed.')}</span>}
    </div></article>;
  })}</>;
}
