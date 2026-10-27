import { randomUUID } from 'node:crypto';
import { connectionInput, SshBackend, type Backend, type BackendFactory } from './backend.js';
import { Store } from './store.js';
import { readSshConfigHosts } from './ssh-config.js';
import { attachmentInput, inputModalitiesOf } from './domain.js';
import { busy, enabledProvidersOf, permissionModes, providerSelection, field, identifier, questionsOf, record, RemoteError, taskInput, type Agent, type AgentDetail, type AgentState, type AgentStatus, type AgentSummary, type Cursor, type Dashboard, type Host, type HostConfig, type PermissionAnswer, type Task, type UsageReport } from './domain.js';

interface Connection { backend: Backend; ready?: Promise<void>; status: Host['status']; error?: string }
export interface UsageOptions {
  /** The conversation's selected route; picks its CLI when the conversation used several. */
  route?: string;
  /** Machine and CLI of the selected route, for a conversation that has not started a session yet. */
  target?: { hostId: string; provider: string };
  /** Also read plan limits, which may contact the SSH host. */
  account?: boolean;
  refresh?: boolean;
}
export interface CreateOptions { title?: string; origin?: Task['origin']; chat?: Task['chat']; signal?: AbortSignal }
export interface SendOptions {
  /** Interrupt a running turn. When false, a working agent rejects the message. */
  interrupt?: boolean;
  signal?: AbortSignal;
}
export class RemoteAgentsService {
  private readonly connections = new Map<string, Connection>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly catalogListeners = new Set<() => void>();
  private closed = false;
  private readonly factory: BackendFactory;
  constructor(readonly store: Store, factory?: BackendFactory, private readonly readSshConfig = readSshConfigHosts) { this.factory = factory ?? (host => new SshBackend(host, store)); }
  async sshConfig() { return this.readSshConfig(); }
  hosts(): Host[] {
    return this.store.hosts().map(({ password, catalog, ...host }) => {
      const enabled = enabledProvidersOf(host), providers = catalog?.providers.filter(p => enabled.includes(p.id)) ?? [];
      return { ...host, enabledProviders: enabled, status: this.connections.get(host.id)?.status ?? 'disconnected', error: this.connections.get(host.id)?.error,
        ...(!enabled.length ? { modelCount: 0 } : {}),
        ...(catalog ? { modelsCheckedAt: catalog.checkedAt, modelCount: providers.filter(p => p.status === 'ready').reduce((n, p) => n + p.models.length, 0),
          providerErrors: providers.filter(p => p.status === 'error').map(p => ({ label: p.label, error: p.error ?? '' })) } : {}) };
    });
  }
  onCatalogChange(listener: () => void): () => void { this.catalogListeners.add(listener); return () => this.catalogListeners.delete(listener); }
  private catalogChanged(): void { for (const listener of this.catalogListeners) listener(); }
  /** Discover once per machine, independent of any configured project. Failed probes keep the saved catalog. */
  async discoverHost(hostId: string): Promise<Dashboard> {
    await this.serial(`catalog:${hostId}`, async () => {
      const host = this.host(hostId);
      if (!enabledProvidersOf(host).length) {
        await this.store.update(state => { const saved = state.hosts.find(h => h.id === hostId); if (saved) delete saved.modelError; });
        this.catalogChanged(); return;
      }
      try {
        const catalog = await this.use(hostId, async backend => {
          const cwd = await backend.homeDirectory();
          return { cwd, providers: await backend.providers(cwd, true), checkedAt: new Date().toISOString() };
        });
        await this.store.update(state => {
          const host = state.hosts.find(h => h.id === hostId);
          if (!host) throw new RemoteError('Remote host was removed', 409);
          host.catalog = catalog; delete host.modelError;
        });
      } catch (error) {
        await this.store.update(state => { const host = state.hosts.find(h => h.id === hostId); if (host) host.modelError = this.safeError(error); });
      }
      this.catalogChanged();
    });
    return this.snapshot();
  }
  async setHostProviders(hostId: string, value: unknown): Promise<Dashboard> {
    const selection = providerSelection(value);
    await this.serial(`catalog:${hostId}`, async () => {
      this.host(hostId);
      await this.store.update(state => {
        const host = state.hosts.find(h => h.id === hostId);
        if (!host) throw new RemoteError('Remote host was removed', 409);
        host.enabledProviders = selection; delete host.modelError;
      });
      this.catalogChanged();
    });
    return this.discoverHost(hostId);
  }
  async snapshot(): Promise<Dashboard> {
    const tasks = this.store.snapshot().tasks;
    return { hosts: this.hosts(), agents: await Promise.all(tasks.map(async task => this.summarize(task, await this.live(task)))) };
  }
  private host(id: string): HostConfig {
    const host = this.store.hosts().find(h => h.id === id);
    if (!host) throw new RemoteError('Remote host not found', 404);
    return host;
  }
  private task(id: string): Task {
    const task = this.store.task(t => t.id === id);
    if (!task) throw new RemoteError('Remote agent not found', 404);
    return task;
  }
  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const host of this.store.hosts()) if (host.password) message = message.split(host.password).join('[redacted]');
    return message.slice(0, 2000);
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private connection(hostId: string): Connection {
    if (this.closed) throw new RemoteError('Remote agent service has stopped', 503);
    let connection = this.connections.get(hostId);
    if (!connection) {
      connection = { backend: this.factory(this.host(hostId)), status: 'disconnected' };
      this.connections.set(hostId, connection);
    }
    return connection;
  }
  private async use<T>(hostId: string, action: (backend: Backend, host: HostConfig) => Promise<T>, expectedServerId?: string): Promise<T> {
    let host = this.host(hostId);
    const current = this.connection(hostId);
    try {
      if (!current.ready) {
        current.status = 'connecting';
        current.ready = (async () => {
          const serverId = await current.backend.connect();
          host = this.host(hostId);
          if (host.serverId && host.serverId !== serverId) throw new RemoteError('Remote SSH machine identity changed. Add it as a new host before starting new agents.', 409);
          if (!host.serverId) await this.store.update(state => {
            const saved = state.hosts.find(h => h.id === hostId);
            if (!saved) throw new RemoteError('Remote host was removed', 409);
            if (saved.serverId && saved.serverId !== serverId) throw new RemoteError('Remote SSH machine identity changed', 409);
            saved.serverId = serverId;
          });
          current.status = 'connected'; current.error = undefined;
        })();
      }
      await current.ready;
      host = this.host(hostId);
      if (expectedServerId && host.serverId !== expectedServerId) throw new RemoteError('Agent belongs to a different remote SSH machine', 409);
      // Recheck the SSH execution identity before each operation.
      const serverId = await current.backend.connect();
      if (serverId !== host.serverId) throw new RemoteError('Remote SSH machine identity changed', 409);
      return await action(current.backend, host);
    } catch (error) {
      current.status = 'error'; current.error = this.safeError(error);
      current.ready = undefined;
      // Independent SSH sessions keep running when another probe or request fails.
      throw new RemoteError(current.error, error instanceof RemoteError ? error.status : 502);
    }
  }
  /** Local process state; never contacts the SSH host. */
  private async live(task: Task): Promise<Agent | null> {
    if (!task.agentId || this.closed) return null;
    try { return await this.connection(task.hostId).backend.agent(task.agentId); } catch { return null; }
  }
  private summarize(task: Task, live: Agent | null): AgentSummary {
    const pending = live?.pendingPermissions.length ?? 0;
    const resumable = live?.resumable ?? task.native?.resumable;
    // A creation record without an in-flight request was interrupted, for example by a DSH restart.
    const status: AgentStatus = task.state === 'creating' && this.locks.has(task.id) ? 'starting'
      : !task.agentId ? 'error'
      : pending ? 'attention'
      : live && (live.status === 'running' || live.status === 'initializing' || live.activeTurn) ? 'running'
      : live?.status === 'error' ? 'error'
      : live?.status === 'closed' && resumable === false ? 'closed' : 'idle';
    const error = status === 'error' ? live?.lastError ?? task.error ?? 'Starting this agent was interrupted. Retry to finish starting it.'
      : status === 'closed' || (status === 'idle' && live?.lastError) ? live?.lastError : undefined;
    return {
      id: task.id, hostId: task.hostId, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model,
      ...(task.chat ? { chatSessionId: task.chat.sessionId } : {}),
      ...(task.modeId ? { modeId: task.modeId } : {}), ...(task.thinkingOptionId ? { thinkingOptionId: task.thinkingOptionId } : {}),
      ...(task.serviceTier ? { serviceTier: task.serviceTier } : {}),
      modes: permissionModes(task.provider, task.modes ?? []), title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt ?? task.createdAt,
      archived: task.archived === true, delegated: task.origin === 'dsh', started: !!task.agentId, attached: !!live && live.status !== 'closed', status, pendingPermissions: pending,
      ...(error ? { error } : {}), ...(resumable !== undefined ? { resumable } : {}), ...(task.native?.sessionId ? { nativeSessionId: task.native.sessionId } : {}),
    };
  }
  async summary(id: string): Promise<AgentSummary> { const task = this.task(id); return this.summarize(task, await this.live(task)); }
  async addHost(input: unknown, options: { discoverModels?: boolean } = {}): Promise<Dashboard> {
    const value = record(input);
    const host: HostConfig = { id: randomUUID(), label: field(value.label, 'host name', 100), connection: connectionInput(value.connection) };
    if (value.enabledProviders !== undefined) host.enabledProviders = providerSelection(value.enabledProviders);
    if (value.password) throw new RemoteError('SSH uses keys or an SSH agent; password storage is not supported');
    await this.store.update(state => {
      if (state.hosts.length >= 16) throw new RemoteError('Up to 16 remote hosts can be saved');
      if (state.hosts.some(h => h.connection === host.connection)) throw new RemoteError('This remote host is already saved', 409);
      state.hosts.push(host);
    });
    if (options.discoverModels) return this.discoverHost(host.id);
    return this.snapshot();
  }
  async removeHost(id: string, options: { deleteAgents?: boolean } = {}): Promise<Dashboard> {
    return this.serial(`catalog:${id}`, async () => {
      this.host(id);
      // Forget local sessions and output without probing an unreachable SSH host.
      if (options.deleteAgents) for (const task of this.store.snapshot().tasks.filter(t => t.hostId === id)) await this.delete(task.id);
      await this.store.update(state => {
        // A concurrently created session still requires confirmation on the next attempt.
        if (state.tasks.some(t => t.hostId === id)) throw new RemoteError('Delete this host’s agents, including archived ones, before removing it', 409);
        state.hosts = state.hosts.filter(h => h.id !== id);
        state.mainChatProjects = state.mainChatProjects?.filter(p => p.hostId !== id);
      });
      const connection = this.connections.get(id); this.connections.delete(id);
      await connection?.backend.close();
      this.catalogChanged();
      return this.snapshot();
    });
  }
  async connect(hostId: string): Promise<Dashboard> {
    await this.use(hostId, async () => {});
    return this.snapshot();
  }
  async providers(hostId: string, cwd: string, refresh = false) { return this.use(hostId, backend => backend.providers(cwd, refresh)); }
  private async updateTask(id: string, update: (task: Task) => void): Promise<Task> {
    await this.store.update(state => {
      const task = state.tasks.find(t => t.id === id);
      if (!task) throw new RemoteError('Remote agent not found', 404);
      update(task);
    });
    return this.task(id);
  }
  async create(input: unknown, options: CreateOptions = {}): Promise<AgentSummary> {
    const request = taskInput(input);
    const title = options.title === undefined ? request.prompt.replace(/\s+/g, ' ').slice(0, 80) : field(options.title, 'title', 100);
    return this.serial(request.id, async () => {
      const existing = this.store.task(t => t.id === request.id);
      if (existing) {
        if (JSON.stringify(taskInput(existing)) !== JSON.stringify(request)) throw new RemoteError('This request ID belongs to a different agent', 409);
        return existing.agentId ? this.summary(existing.id) : this.launch(existing, options.signal);
      }
      return this.use(request.hostId, async (backend, host) => {
        if (!enabledProvidersOf(host).includes(request.provider)) throw new RemoteError('This CLI is disabled on this machine. Enable it in Settings → Remote agents.', 409);
        const providers = await backend.providers(request.cwd, false);
        const provider = providers.find(p => p.id === request.provider);
        if (!provider || provider.status !== 'ready') throw new RemoteError('The selected CLI is not ready in this remote project', 409);
        const model = provider.models.find(m => m.id === request.model);
        if (!model) throw new RemoteError('The selected model is unavailable on this host', 409);
        if (request.attachments?.some(a => a.kind === 'image') && !inputModalitiesOf(provider.id, model).includes('image')) throw new RemoteError('This remote CLI does not support image input');
        if (request.modeId && !permissionModes(provider.id, provider.modes).some(m => m.id === request.modeId)) throw new RemoteError('The selected mode is unavailable', 409);
        if (request.thinkingOptionId && !model.thinkingOptions?.some(m => m.id === request.thinkingOptionId)) throw new RemoteError('The selected thinking level is unavailable', 409);
        if (request.serviceTier && !model.serviceTiers?.some(t => t.id === request.serviceTier)) throw new RemoteError('The selected speed is unavailable', 409);
        const now = new Date().toISOString();
        const task: Task = { ...request, serverId: host.serverId!, title, createdAt: now, updatedAt: now, modes: provider.modes, ...(options.origin ? { origin: options.origin } : {}), ...(options.chat ? { chat: options.chat } : {}), state: 'creating' };
        // Persist the exact execution intent and idempotency key before any remote mutation.
        await this.store.update(state => {
          if (!state.hosts.some(h => h.id === task.hostId && h.serverId === task.serverId)) throw new RemoteError('Remote host binding changed', 409);
          if (state.tasks.length >= 1000) throw new RemoteError('The remote agent registry is full. Delete archived agents first.');
          state.tasks.push(task);
        });
        return this.launch(task, options.signal);
      });
    });
  }
  /** Retry an interrupted start, or reattach a stopped session without replaying anything. */
  async retry(id: string, signal?: AbortSignal): Promise<AgentSummary> {
    const task = this.task(id);
    if (!task.agentId) return this.create(taskInput(task), { signal });
    return this.serial(id, () => this.use(task.hostId, async backend => {
      const agent = await backend.recover(this.task(id), signal);
      this.assertAgent(task, agent);
      await this.updateTask(id, next => { next.state = 'ready'; delete next.error; });
      return this.summary(id);
    }, task.serverId));
  }
  private async launch(task: Task, signal?: AbortSignal): Promise<AgentSummary> {
    try {
      await this.use(task.hostId, async backend => {
        const agent = await backend.create(task, signal);
        if (agent.provider !== task.provider) throw new Error('Created agent provider does not match the request');
        await this.updateTask(task.id, next => { next.agentId = agent.id; next.executionCwd = agent.cwd; next.state = 'ready'; delete next.error; });
      }, task.serverId);
    } catch (error) {
      // Keep the agent address available to the UI for an idempotent retry.
      await this.updateTask(task.id, next => { next.state = 'uncertain'; next.error = this.safeError(error); });
    }
    return this.summary(task.id);
  }
  private assertAgent(task: Task, agent: Agent | null): asserts agent is Agent {
    if (!agent) throw new RemoteError('The remote agent no longer exists', 404);
    if (agent.cwd !== (task.executionCwd ?? task.cwd) || agent.provider !== task.provider) throw new RemoteError('Remote agent identity or project changed', 409);
  }
  async state(id: string): Promise<AgentState> {
    const task = this.task(id), live = await this.live(task);
    return { agent: this.summarize(task, live), permissions: live?.pendingPermissions ?? [] };
  }
  /** Saved output stays readable while the SSH host is offline. */
  async detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<AgentDetail> {
    const task = this.task(id), live = await this.live(task);
    if (live) this.assertAgent(task, live);
    const timeline = task.agentId ? await this.connection(task.hostId).backend.timeline(task.agentId, cursor, direction) : null;
    return { agent: this.summarize(task, live), permissions: live?.pendingPermissions ?? [], timeline };
  }
  async reply(id: string): Promise<string> {
    const task = this.task(id);
    return task.agentId ? this.connection(task.hostId).backend.reply(task.agentId) : '';
  }
  async messageTimeline(id: string, messageId: string, cursor?: Cursor) {
    const task = this.task(id);
    if (!task.agentId) throw new RemoteError('Remote agent is not ready', 409);
    return this.connection(task.hostId).backend.messageTimeline(task.agentId, messageId, cursor);
  }
  async setThinking(id: string, thinkingOptionId?: string): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id);
      if (task.thinkingOptionId === thinkingOptionId) return;
      if (busy(await this.summary(id))) throw new RemoteError('Stop the agent before changing its thinking level', 409);
      if (task.native?.resumable === false) throw new RemoteError('This CLI cannot resume with a different thinking level', 409);
      if (task.agentId) await this.connection(task.hostId).backend.detach(task);
      await this.updateTask(id, next => { next.thinkingOptionId = thinkingOptionId; });
    });
  }
  /** Change a model or speed by resuming the same native session. Existing receipts keep their original namespace. */
  async setModel(id: string, model: string, thinkingOptionId?: string, route?: string, serviceTier?: string): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id);
      if (task.model === model && task.thinkingOptionId === thinkingOptionId && task.serviceTier === serviceTier) return;
      if (busy(await this.summary(id))) throw new RemoteError('Stop the agent before changing its model', 409);
      if (task.native?.resumable === false) throw new RemoteError('This CLI cannot resume with a different model. Start a new conversation.', 409);
      await this.use(task.hostId, async backend => {
        const provider = (await backend.providers(task.cwd, false)).find(p => p.id === task.provider && p.status === 'ready');
        const selected = provider?.models.find(m => m.id === model);
        if (!selected) throw new RemoteError('The selected model is unavailable on this host', 409);
        if (thinkingOptionId && !selected.thinkingOptions?.some(e => e.id === thinkingOptionId)) throw new RemoteError('The selected thinking level is unavailable', 409);
        if (serviceTier && !selected.serviceTiers?.some(t => t.id === serviceTier)) throw new RemoteError('The selected speed is unavailable', 409);
        if (task.agentId) await backend.detach(task);
        await this.updateTask(id, next => {
          next.model = model; next.thinkingOptionId = thinkingOptionId; next.serviceTier = serviceTier;
          if (next.chat && route) { next.chat.receiptRoute ??= next.chat.route; next.chat.route = route; }
        });
      }, task.serverId);
    });
  }
  /** Context comes from local state; only plan limits are read from the SSH host, and they are cached. */
  async usage(sessionId: string, options: UsageOptions = {}): Promise<UsageReport | null> {
    const cli = (route: string) => route.split('/').slice(0, 2).join('/');
    const task = this.store.tasks(t => t.chat?.sessionId === sessionId && (!options.route || cli(t.chat.route) === cli(options.route)))
      .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))[0];
    const target = task ? { hostId: task.hostId, provider: task.provider } : options.target;
    if (!target) return null;
    const report: UsageReport = { provider: target.provider, context: task ? (await this.live(task))?.context ?? task.context ?? null : null };
    if (!options.account) return report;
    try {
      const account = await this.use(target.hostId, backend => backend.account(target.provider, task ? task.executionCwd ?? task.cwd : undefined, options.refresh === true), task?.serverId);
      if (account) report.account = account;
    } catch (error) { report.account = { provider: target.provider, windows: [], checkedAt: new Date().toISOString(), error: this.safeError(error) }; }
    return report;
  }
  async rename(id: string, title: string): Promise<AgentSummary> {
    return this.serial(id, async () => {
      await this.updateTask(id, next => { next.title = field(title, 'title', 100); });
      return this.summary(id);
    });
  }
  async send(id: string, input: unknown, options: SendOptions = {}): Promise<AgentSummary> {
    const value = record(input), messageId = identifier(value.id), text = field(value.text, 'message', 100_000);
    const attachments = value.attachments === undefined ? undefined : attachmentInput(value.attachments);
    return this.serial(id, async () => {
      const task = this.task(id);
      if (!task.agentId) throw new RemoteError('Retry starting this agent before sending a message', 409);
      if ((await this.messageTimeline(id, messageId)).found) return this.summary(id);
      if (options.interrupt === false && busy(await this.summary(id))) throw new RemoteError('This agent is still working. Wait for it, or interrupt it to send now.', 409);
      return this.use(task.hostId, async backend => {
        const live = await backend.agent(task.agentId!); this.assertAgent(task, live);
        if (live.status === 'closed' && (live.resumable ?? task.native?.resumable) === false) throw new RemoteError('This CLI session has ended and cannot be resumed. Its output is kept.', 409);
        // Messaging an archived agent brings it back, as in Paseo.
        await this.updateTask(id, next => { next.updatedAt = new Date().toISOString(); delete next.archived; });
        await backend.send(task.agentId!, text, messageId, attachments, options.signal);
        return this.summary(id);
      }, task.serverId);
    });
  }
  async stop(id: string): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id);
      if (!task.agentId) return;
      const backend = this.connection(task.hostId).backend;
      this.assertAgent(task, await backend.agent(task.agentId));
      // Interrupting uses the already-open SSH pipe; it must work while the host is otherwise unreachable.
      await backend.stop(task.agentId);
    });
  }
  async respond(id: string, requestId: string, input: unknown): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id), value = record(input);
      if (!task.agentId) throw new RemoteError('Remote agent is not ready', 409);
      if (value.behavior !== 'allow' && value.behavior !== 'deny') throw new RemoteError('Invalid permission response');
      const answer: PermissionAnswer = { behavior: value.behavior };
      if (value.selectedActionId !== undefined) answer.selectedActionId = field(value.selectedActionId, 'permission action', 500);
      if (value.message !== undefined) answer.message = field(value.message, 'permission message', 10_000);
      if (value.answers !== undefined) {
        const answers = record(value.answers);
        if (Object.values(answers).some(v => typeof v !== 'string' || v.length > 10_000)) throw new RemoteError('Invalid question answers');
        answer.answers = answers as Record<string, string>;
      }
      const backend = this.connection(task.hostId).backend;
      const agent = await backend.agent(task.agentId); this.assertAgent(task, agent);
      const permission = agent.pendingPermissions.find(p => p.id === requestId);
      if (!permission) throw new RemoteError('This permission request is no longer pending', 409);
      if (permission.actions?.length && answer.behavior === 'allow' && !answer.selectedActionId) throw new RemoteError('Select one of the available permission actions');
      if (answer.selectedActionId && !permission.actions?.some(a => a.id === answer.selectedActionId && a.behavior === answer.behavior)) throw new RemoteError('Invalid permission action');
      if (permission.kind === 'question' && answer.behavior === 'allow' && !permission.actions?.length) {
        const questions = questionsOf(permission.input);
        if (!questions.length) throw new RemoteError('This CLI returned an unsupported question format');
        if (questions.some(q => !Object.hasOwn(answer.answers ?? {}, q.header) || (!q.optional && !answer.answers?.[q.header]?.trim()))) throw new RemoteError('Answer every required question');
        const allowed = new Set(questions.map(q => q.header));
        if (Object.keys(answer.answers ?? {}).some(key => !allowed.has(key))) throw new RemoteError('Unknown question answer');
      }
      await backend.respond(agent.id, permission.id, answer, permission.input);
    });
  }
  /** Soft delete: interrupt, release the CLI process and hide the agent. Output and the native session are kept. */
  async archive(id: string, archived = true): Promise<AgentSummary> {
    return this.serial(id, async () => {
      const task = this.task(id);
      if (archived) await this.connection(task.hostId).backend.detach(task);
      await this.updateTask(id, next => { if (archived) next.archived = true; else delete next.archived; });
      return this.summary(id);
    });
  }
  async delete(id: string): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id);
      await this.connection(task.hostId).backend.forget(task);
      await this.store.update(state => { state.tasks = state.tasks.filter(t => t.id !== id); });
    });
  }
  /** Applies from the next message: the idle session is released and resumed with the new mode. */
  async setMode(id: string, modeId: string): Promise<AgentSummary> {
    return this.serial(id, async () => {
      const task = this.task(id);
      if (!permissionModes(task.provider, task.modes ?? []).some(m => m.id === modeId)) throw new RemoteError('This mode is not available for this agent', 409);
      if (task.modeId === modeId) return this.summary(id);
      const live = await this.live(task);
      if (live && busy(this.summarize(task, live))) throw new RemoteError('Stop the agent before changing its mode', 409);
      if (live && live.status !== 'closed' && task.native?.resumable === false) throw new RemoteError('This CLI cannot resume its session, so its mode cannot change', 409);
      if (task.agentId) await this.connection(task.hostId).backend.detach(task);
      await this.updateTask(id, next => { next.modeId = modeId; });
      return this.summary(id);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.connections.values()].map(c => c.backend.close()));
    // Let in-flight mutations persist their final receipt before a plugin reload opens state.
    await Promise.allSettled([...this.locks.values()]);
    this.connections.clear(); await this.store.flush();
  }
}
