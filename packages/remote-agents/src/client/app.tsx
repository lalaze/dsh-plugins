import React, { useCallback, useEffect, useId, useState } from 'react';
import type { Dashboard, Provider, Task, TaskInput, Workspace } from '../domain.js';
import { api, ApiError, newRequestId, readLocal, saveLocal } from './api.js';
import { localizeError, ui, useLocale } from './i18n.js';
import { TaskView } from './task-view.js';
import { styles } from './styles.js';
import { SshHostPicker } from './ssh-host-picker.js';

const initial: Dashboard = { hosts: [], tasks: [] };
export function RemoteAgentsApp() {
  useLocale();
  const hostSelectId = useId();
  const [dashboard, setDashboard] = useState(initial), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [hostId, setHostId] = useState(readLocal<string>('host') ?? ''), [taskId, setTaskId] = useState(readLocal<string>('task') ?? '');
  const [label, setLabel] = useState(''), [connection, setConnection] = useState('');
  const [cwd, setCwd] = useState(''), [workspaces, setWorkspaces] = useState<Workspace[]>([]), [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]), [catalogKey, setCatalogKey] = useState(''), [discovering, setDiscovering] = useState(false);
  const [providerId, setProviderId] = useState(''), [modelId, setModelId] = useState(''), [modeId, setModeId] = useState(''), [thinking, setThinking] = useState('');
  const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState('');
  const [pending, setPending] = useState(() => readLocal<TaskInput>('create'));
  const host = dashboard.hosts.find(h => h.id === hostId), task = dashboard.tasks.find(t => t.id === taskId);
  const provider = providers.find(p => p.id === providerId), model = provider?.models.find(m => m.id === modelId);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    const reload = async () => {
      try { const result = await api<Dashboard>(undefined, {}, controller.signal); if (active) { setDashboard(result); setLoading(false); } }
      catch (e) { if (active) { setError(localizeError(e)); setLoading(false); } }
    };
    void reload(); const timer = setInterval(() => { if (!document.hidden) void reload(); }, 5000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, []);
  const updateTask = useCallback((next: Task) => setDashboard(previous => ({ ...previous, tasks: previous.tasks.map(t => t.id === next.id ? next : t) })), []);
  useEffect(() => {
    if (dashboard.hosts.length && !dashboard.hosts.some(h => h.id === hostId)) setHostId(dashboard.hosts[0].id);
  }, [dashboard.hosts, hostId]);
  useEffect(() => {
    saveLocal('host', hostId); setWorkspaces([]); setProviders([]); setCatalogKey(''); setProviderId(''); setModelId('');
    const path = readLocal<string>(`cwd.${hostId}`) ?? ''; setCwd(path);
    if (!hostId) return;
    const controller = new AbortController(); setWorkspacesLoading(true);
    void api<Workspace[]>('workspaces', { hostId }, controller.signal).then(setWorkspaces).catch(e => { if (!controller.signal.aborted) setError(localizeError(e)); }).finally(() => { if (!controller.signal.aborted) setWorkspacesLoading(false); });
    return () => controller.abort();
  }, [hostId]);
  useEffect(() => { saveLocal('task', taskId); }, [taskId]);
  const chooseHost = (id: string) => { setHostId(id); setTaskId(''); setError(''); };
  const choosePath = (path: string) => { setCwd(path); setProviders([]); setCatalogKey(''); saveLocal(`cwd.${hostId}`, path); };
  const chooseProvider = (id: string, list = providers) => {
    const p = list.find(p => p.id === id), m = p?.models.find(m => m.isDefault) ?? p?.models[0];
    setProviderId(id); setModelId(m?.id ?? ''); setModeId(p?.defaultModeId ?? ''); setThinking(m?.defaultThinkingOptionId ?? '');
  };
  useEffect(() => {
    if (!hostId || !cwd || catalogKey !== `${hostId}:${cwd}` || !providers.some(p => p.status === 'loading')) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<Provider[]>('providers', { hostId, cwd }, controller.signal).then(result => {
        setProviders(result); if (!providerId || !result.some(p => p.id === providerId && p.status === 'ready')) chooseProvider(result.find(p => p.status === 'ready')?.id ?? '', result);
      }).catch(e => { if (!controller.signal.aborted) setError(localizeError(e)); });
    }, 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [providers, hostId, cwd, catalogKey]);
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await action(); } catch (e) { setError(localizeError(e)); }
    finally { setBusy(''); }
  };
  const clearPending = () => { setPending(undefined); saveLocal('create', undefined); };
  const recover = (input: TaskInput) => run('create', async () => {
    let next: Task;
    try { next = await api<Task>('create', { task: input }); }
    catch (error) {
      if (error instanceof ApiError && error.rejected) { clearPending(); setPrompt(input.prompt); }
      throw error;
    }
    clearPending(); setPrompt(''); setHostId(next.hostId); setTaskId(next.id);
    setDashboard(previous => ({ ...previous, tasks: [...previous.tasks.filter(task => task.id !== next.id), next] }));
    setDashboard(await api<Dashboard>());
  });
  const discover = async () => {
    const selectedHost = hostId, selectedPath = cwd.trim(); setDiscovering(true); setError('');
    try {
      const result = await api<Provider[]>('providers', { hostId: selectedHost, cwd: selectedPath, refresh: true });
      setProviders(result); setCatalogKey(`${selectedHost}:${selectedPath}`); setCwd(selectedPath); saveLocal(`cwd.${selectedHost}`, selectedPath);
      chooseProvider(result.find(p => p.status === 'ready')?.id ?? '', result);
      setDashboard(await api<Dashboard>());
    } catch (e) { setError(localizeError(e)); }
    finally { setDiscovering(false); }
  };
  return <section className="dsh-ra" aria-label={ui('Remote agents')}><style>{styles}</style>
    <header className="ra-top"><div><h2>{ui('Remote agents')}</h2><p className="ra-muted">{ui('Run a coding CLI in a remote project.')}</p></div><button disabled={!!busy} onClick={() => void run('refresh', async () => setDashboard(await api<Dashboard>()))}>{ui(busy === 'refresh' ? 'Working…' : 'Refresh')}</button></header>
    {error && <div className="ra-notice" role="alert">{error}</div>}
    <section className="ra-hosts" aria-label={ui('Hosts')}>
      {dashboard.hosts.length > 0 && <div className="ra-host-picker"><label htmlFor={hostSelectId}>{ui('Host')}</label><select id={hostSelectId} aria-label={ui('Host')} value={hostId} disabled={!!busy || discovering} onChange={event => chooseHost(event.target.value)}>{dashboard.hosts.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}</select>{host && <span className="ra-badge" data-status={host.status}>{ui(host.status)}</span>}<button disabled={!host || !!busy} onClick={() => void run('connect', async () => setDashboard(await api<Dashboard>('connect', { hostId })))}>{ui('Connect')}</button>{host && !dashboard.tasks.some(t => t.hostId === hostId) && <button className="ra-danger" disabled={!!busy} onClick={() => void run('remove', async () => { const next = await api<Dashboard>('removeHost', { hostId }); setDashboard(next); chooseHost(next.hosts[0]?.id ?? ''); })}>{ui('Remove host')}</button>}</div>}
      <details className="ra-host-form" open={!dashboard.hosts.length ? true : undefined}><summary>{ui('Add host')}</summary><p className="ra-muted" style={{ marginTop: 8 }}>{ui('Connect directly over SSH using a host alias or user@host.')}</p><form onSubmit={event => { event.preventDefault(); void run('host', async () => {
        const next = await api<Dashboard>('addHost', { host: { label, connection } });
        setDashboard(next); chooseHost(next.hosts.at(-1)!.id); setLabel(''); setConnection('');
      }); }}>
        <SshHostPicker hosts={dashboard.hosts} connection={connection} disabled={!!busy} select={host => { setLabel(host.alias.slice(0, 100)); setConnection(host.connection); }} />
        <div className="ra-grid"><label className="ra-field">{ui('Host name')}<input aria-label={ui('Host name')} required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder="Development server" /></label><label className="ra-field">{ui('Connection')}<input aria-label={ui('Connection')} required value={connection} onChange={event => setConnection(event.target.value)} placeholder="ssh://user@build-box:22" autoComplete="off" /></label><div className="ra-field" style={{ justifyContent: 'end' }}><button className="ra-primary" disabled={!!busy || !label.trim() || !connection.trim()}>{ui(busy === 'host' ? 'Saving…' : 'Save host')}</button></div></div>
        <p className="ra-foot">{ui('SSH uses the DSH server’s keys and SSH config.')}</p>
      </form></details>
    </section>
    {loading ? <div className="ra-empty" role="status">{ui('Loading tasks…')}</div> : !host ? <div className="ra-empty"><h3>{ui('No hosts yet')}</h3><p>{ui('Add a machine to discover its coding CLIs.')}</p></div> : <div className="ra-body">
      <aside className="ra-sidebar"><div className="ra-actions" style={{ justifyContent: 'space-between' }}><h3>{ui('Tasks')}</h3><button disabled={!!busy} onClick={() => setTaskId('')}>{ui('New task')}</button></div><div className="ra-task-list">{dashboard.tasks.filter(t => t.hostId === hostId).slice().reverse().map(t => <button className="ra-task-button" aria-pressed={taskId === t.id} key={t.id} onClick={() => setTaskId(t.id)}><span className="ra-task-title">{t.title}</span><span className="ra-task-sub">{t.provider} · {t.model}</span></button>)}</div>{!dashboard.tasks.some(t => t.hostId === hostId) && <p className="ra-muted" style={{ marginTop: 18 }}>{ui('No tasks on this host')}</p>}</aside>
      <main className="ra-main">{task && task.hostId === hostId ? <TaskView key={task.id} task={task} host={host} update={updateTask} /> : <>
        <h3>{ui('New task')}</h3>
        {pending && <div className="ra-notice"><p>{ui('Submission was not confirmed. Recover it using the same request ID.')}</p><div className="ra-actions"><button disabled={!!busy} onClick={() => void recover(pending)}>{ui('Recover submission')}</button><button disabled={!!busy} onClick={() => { setPrompt(pending.prompt); clearPending(); setError(''); }}>{ui('Discard saved submission')}</button></div><p className="ra-foot">{ui('Discarding clears only this saved submission. Check the task list before submitting again.')}</p></div>}
        <form onSubmit={event => { event.preventDefault(); if (!provider || !model || pending || discovering || catalogKey !== `${hostId}:${cwd}`) return;
          const input: TaskInput = { id: newRequestId(), hostId, cwd, provider: provider.id, model: model.id, prompt: prompt.trim(), ...(modeId ? { modeId } : {}), ...(thinking ? { thinkingOptionId: thinking } : {}) };
          saveLocal('create', input); setPending(input); void recover(input);
        }}>
          <div className="ra-grid"><label className="ra-field ra-wide">{ui('Saved workspaces')}<select aria-label={ui('Saved workspaces')} value={workspaces.find(w => w.path === cwd)?.id ?? ''} disabled={discovering || !!busy} onChange={event => { const selected = workspaces.find(w => w.id === event.target.value); if (selected) choosePath(selected.path); }}><option value="">{ui(workspacesLoading ? 'Loading remote workspaces…' : 'Enter another directory')}</option>{workspaces.map(w => <option value={w.id} key={w.id}>{w.name} · {w.path}</option>)}</select></label>
            <label className="ra-field ra-wide">{ui('Remote project')}<input aria-label={ui('Remote project')} value={cwd} onChange={event => choosePath(event.target.value)} disabled={discovering || !!busy} placeholder="/srv/projects/my-app" required /><span className="ra-muted">{ui('Absolute path on the selected remote machine')}</span></label>
            <div className="ra-wide"><button type="button" disabled={!cwd.trim() || discovering || !!busy} onClick={() => void discover()}>{ui(discovering ? 'Discovering…' : 'Discover CLIs')}</button></div>
          </div>
          {providers.length > 0 && <div className="ra-provider-list">{providers.map(p => <span className="ra-badge" data-status={p.status} key={p.id} title={p.error}>{p.label} · {ui(p.status)}</span>)}</div>}
          {!!catalogKey && !providers.some(p => p.status === 'ready' || p.status === 'loading') && <div className="ra-notice"><h3>{ui('No ready CLI found')}</h3><p>{ui('Install and sign in to a CLI on the remote host, then refresh discovery.')}</p></div>}
          {providers.filter(p => p.error).map(p => <p className="ra-notice" key={p.id}>{p.label}: {p.error}</p>)}
          {provider?.notice && <p className="ra-notice">{ui(provider.notice)}</p>}
          <div className="ra-grid"><label className="ra-field">{ui('CLI provider')}<select aria-label={ui('CLI provider')} value={providerId} disabled={discovering || !!busy || !providers.length} onChange={event => chooseProvider(event.target.value)}><option value="">{ui('Choose a ready CLI')}</option>{providers.map(p => <option key={p.id} value={p.id} disabled={p.status !== 'ready'}>{p.label}</option>)}</select></label>
            <label className="ra-field">{ui('Model')}<select aria-label={ui('Model')} value={modelId} disabled={!provider || !!busy || discovering} onChange={event => { setModelId(event.target.value); setThinking(provider?.models.find(m => m.id === event.target.value)?.defaultThinkingOptionId ?? ''); }}>{provider?.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
            <label className="ra-field">{ui('Permission mode')}<select aria-label={ui('Permission mode')} value={modeId} disabled={!provider || !!busy || discovering} onChange={event => setModeId(event.target.value)}><option value="">{ui('CLI default')}</option>{provider?.modes.map(m => <option value={m.id} key={m.id}>{m.label}</option>)}</select></label>
            {!!model?.thinkingOptions?.length && <label className="ra-field">{ui('Thinking level')}<select aria-label={ui('Thinking level')} value={thinking} disabled={!!busy} onChange={event => setThinking(event.target.value)}><option value="">{ui('CLI default')}</option>{model.thinkingOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}
            <label className="ra-field ra-wide">{ui('Task instructions')}<textarea aria-label={ui('Task instructions')} required maxLength={100_000} rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={ui('Describe the work to run in this remote project…')} disabled={!!busy} /></label>
            <div className="ra-wide"><button className="ra-primary" disabled={!!busy || discovering || !!pending || !model || !provider || provider.status !== 'ready' || !prompt.trim() || catalogKey !== `${hostId}:${cwd}`}>{ui(busy === 'create' ? 'Starting…' : 'Start task')}</button></div>
          </div>
        </form>
      </>}</main>
    </div>}
  </section>;
}
