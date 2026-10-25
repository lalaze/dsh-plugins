import { randomUUID } from 'node:crypto';
import { connectionInput, SshBackend, type Backend, type BackendFactory } from './backend.js';
import { Store } from './store.js';
import { field, identifier, questionsOf, record, RemoteError, taskInput, type Agent, type Cursor, type Dashboard, type Host, type HostConfig, type PermissionAnswer, type Task, type TaskDetail, type TaskInput } from './domain.js';

interface Connection { backend: Backend; ready?: Promise<void>; status: Host['status']; error?: string }
export class RemoteAgentsService {
  private readonly connections = new Map<string, Connection>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly factory: BackendFactory;
  constructor(readonly store: Store, factory?: BackendFactory) { this.factory = factory ?? (host => new SshBackend(host, store)); }
  snapshot(): Dashboard {
    const state = this.store.snapshot();
    return {
      hosts: state.hosts.map(({ password, ...host }) => ({ ...host, status: this.connections.get(host.id)?.status ?? 'disconnected', error: this.connections.get(host.id)?.error })),
      tasks: state.tasks,
    };
  }
  private host(id: string): HostConfig {
    const host = this.store.snapshot().hosts.find(h => h.id === id);
    if (!host) throw new RemoteError('Remote host not found', 404);
    return host;
  }
  private task(id: string): Task {
    const task = this.store.snapshot().tasks.find(t => t.id === id);
    if (!task) throw new RemoteError('Remote task not found', 404);
    return task;
  }
  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const host of this.store.snapshot().hosts) if (host.password) message = message.split(host.password).join('[redacted]');
    return message.slice(0, 2000);
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private connection(hostId: string): Connection {
    if (this.closed) throw new RemoteError('Remote task service has stopped', 503);
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
          if (host.serverId && host.serverId !== serverId) throw new RemoteError('Remote SSH machine identity changed. Add it as a new host before starting new tasks.', 409);
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
      if (expectedServerId && host.serverId !== expectedServerId) throw new RemoteError('Task belongs to a different remote SSH machine', 409);
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
  async addHost(input: unknown): Promise<Dashboard> {
    const value = record(input);
    const host: HostConfig = { id: randomUUID(), label: field(value.label, 'host name', 100), connection: connectionInput(value.connection) };
    if (value.password) throw new RemoteError('SSH uses keys or an SSH agent; password storage is not supported');
    await this.store.update(state => {
      if (state.hosts.length >= 16) throw new RemoteError('Up to 16 remote hosts can be saved');
      if (state.hosts.some(h => h.connection === host.connection)) throw new RemoteError('This remote host is already saved', 409);
      state.hosts.push(host);
    });
    return this.snapshot();
  }
  async removeHost(id: string): Promise<Dashboard> {
    this.host(id);
    await this.store.update(state => {
      if (state.tasks.some(t => t.hostId === id)) throw new RemoteError('This host has saved tasks and cannot be removed', 409);
      state.hosts = state.hosts.filter(h => h.id !== id);
    });
    const connection = this.connections.get(id); this.connections.delete(id);
    await connection?.backend.close();
    return this.snapshot();
  }
  async connect(hostId: string): Promise<Dashboard> {
    await this.use(hostId, async () => {});
    return this.snapshot();
  }
  async workspaces(hostId: string) { return this.use(hostId, backend => backend.workspaces()); }
  async providers(hostId: string, cwd: string, refresh = false) { return this.use(hostId, backend => backend.providers(cwd, refresh)); }
  private async updateTask(id: string, update: (task: Task) => void): Promise<Task> {
    await this.store.update(state => {
      const task = state.tasks.find(t => t.id === id);
      if (!task) throw new RemoteError('Remote task not found', 404);
      update(task);
    });
    return this.task(id);
  }
  async create(input: unknown): Promise<Task> {
    const request = taskInput(input);
    return this.serial(request.id, async () => {
      const existing = this.store.snapshot().tasks.find(t => t.id === request.id);
      if (existing) {
        const original = taskInput(existing);
        if (JSON.stringify(original) !== JSON.stringify(request)) throw new RemoteError('This request ID belongs to a different task', 409);
        if (existing.agentId) return existing;
        return this.launch(existing);
      }
      return this.use(request.hostId, async (backend, host) => {
        const providers = await backend.providers(request.cwd, false);
        const provider = providers.find(p => p.id === request.provider);
        if (!provider || provider.status !== 'ready') throw new RemoteError('The selected CLI is not ready in this remote project', 409);
        const model = provider.models.find(m => m.id === request.model);
        if (!model) throw new RemoteError('The selected model is unavailable on this host', 409);
        if (request.modeId && !provider.modes.some(m => m.id === request.modeId)) throw new RemoteError('The selected mode is unavailable', 409);
        if (request.thinkingOptionId && !model.thinkingOptions?.some(m => m.id === request.thinkingOptionId)) throw new RemoteError('The selected thinking level is unavailable', 409);
        const task: Task = { ...request, serverId: host.serverId!, title: request.prompt.slice(0, 80), createdAt: new Date().toISOString(), state: 'creating', submissions: [] };
        // Persist the exact execution intent and idempotency key before any remote mutation.
        await this.store.update(state => {
          if (!state.hosts.some(h => h.id === task.hostId && h.serverId === task.serverId)) throw new RemoteError('Remote host binding changed', 409);
          if (state.tasks.length >= 1000) throw new RemoteError('The remote task registry is full');
          state.tasks.push(task);
        });
        return this.launch(task);
      });
    });
  }
  async retry(id: string): Promise<Task> {
    const task = this.task(id);
    if (!task.agentId) return this.create(taskInput(task));
    return this.serial(id, () => this.use(task.hostId, async backend => {
      const agent = backend.recover ? await backend.recover(this.task(id)) : await backend.agent(task.agentId!);
      this.assertAgent(task, agent);
      return this.updateTask(id, next => { next.state = 'ready'; delete next.error; });
    }, task.serverId));
  }
  private async launch(task: Task): Promise<Task> {
    try {
      return await this.use(task.hostId, async backend => {
        const agent = await backend.create(task);
        if (agent.provider !== task.provider) throw new Error('Created agent provider does not match the task');
        return this.updateTask(task.id, next => { next.agentId = agent.id; next.executionCwd = agent.cwd; next.state = 'ready'; delete next.error; });
      }, task.serverId);
    } catch (error) {
      await this.updateTask(task.id, next => { next.state = 'uncertain'; next.error = this.safeError(error); });
      // Keep the task address available to the UI for an idempotent recovery.
      return this.task(task.id);
    }
  }
  private assertAgent(task: Task, agent: Agent | null): asserts agent is Agent {
    if (!agent) throw new RemoteError('The remote agent no longer exists', 404);
    if (agent.cwd !== (task.executionCwd ?? task.cwd) || agent.provider !== task.provider) throw new RemoteError('Remote agent identity or project changed', 409);
  }
  async detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TaskDetail> {
    const task = this.task(id);
    if (!task.agentId) return { task, agent: null, timeline: null };
    const read = async (backend: Backend) => {
      const agent = await backend.agent(task.agentId!); this.assertAgent(task, agent);
      const timeline = await backend.timeline(task.agentId!, cursor, direction);
      const seen = new Set(timeline.entries.filter(e => e.item.type === 'delivery' || (e.item.type === 'user_message' && e.item.delivery !== 'pending')).flatMap(e => [e.item.clientMessageId, e.item.messageId]));
      const reconciled = task.submissions.some(s => s.state !== 'accepted' && seen.has(s.id))
        ? await this.updateTask(id, next => { for (const submission of next.submissions) if (seen.has(submission.id)) { submission.state = 'accepted'; delete submission.error; } })
        : task;
      return { task: reconciled, agent, timeline };
    };
    const backend = this.connection(task.hostId).backend;
    // Direct SSH histories are local. An unavailable host must not hide saved output.
    return backend.localReads ? read(backend) : this.use(task.hostId, read, task.serverId);
  }
  async send(id: string, input: unknown): Promise<Task> {
    const value = record(input), messageId = identifier(value.id), text = field(value.text, 'message', 100_000);
    return this.serial(id, async () => {
      let task = this.task(id);
      const prior = task.submissions.find(s => s.id === messageId);
      if (prior) {
        if (prior.text !== text) throw new RemoteError('This request ID belongs to another message', 409);
        return task; // Pending/uncertain sends are never replayed automatically.
      }
      if (!task.agentId) throw new RemoteError('Recover task creation before sending a follow-up', 409);
      return this.use(task.hostId, async backend => {
        const agent = await backend.agent(task.agentId!); this.assertAgent(task, agent);
        if (agent.status !== 'idle' || agent.activeTurn || agent.pendingPermissions.length) throw new RemoteError('Wait for this task to finish or stop it before sending a follow-up', 409);
        task = await this.updateTask(id, next => { next.submissions.push({ id: messageId, text, state: 'pending' }); });
        try {
          await backend.send(task.agentId!, text, messageId);
          return this.task(id); // Native output, rather than a successful pipe write, confirms delivery.
        } catch (error) {
          return this.updateTask(id, next => { const submission = next.submissions.find(s => s.id === messageId)!; submission.state = 'uncertain'; submission.error = this.safeError(error); });
        }
      }, task.serverId);
    });
  }
  async stop(id: string): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id);
      if (!task.agentId) throw new RemoteError('Recover task creation before stopping it', 409);
      await this.use(task.hostId, async backend => {
        const agent = await backend.agent(task.agentId!); this.assertAgent(task, agent);
        await backend.stop(agent.id);
      }, task.serverId);
    });
  }
  async respond(id: string, requestId: string, input: unknown): Promise<void> {
    return this.serial(id, async () => {
      const task = this.task(id), value = record(input);
      if (!task.agentId) throw new RemoteError('Remote task is not ready', 409);
      if (value.behavior !== 'allow' && value.behavior !== 'deny') throw new RemoteError('Invalid permission response');
      const answer: PermissionAnswer = { behavior: value.behavior };
      if (value.selectedActionId !== undefined) answer.selectedActionId = field(value.selectedActionId, 'permission action', 500);
      if (value.message !== undefined) answer.message = field(value.message, 'permission message', 10_000);
      if (value.answers !== undefined) {
        const answers = record(value.answers);
        if (Object.values(answers).some(v => typeof v !== 'string' || v.length > 10_000)) throw new RemoteError('Invalid question answers');
        answer.answers = answers as Record<string, string>;
      }
      await this.use(task.hostId, async backend => {
        const agent = await backend.agent(task.agentId!); this.assertAgent(task, agent);
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
      }, task.serverId);
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
