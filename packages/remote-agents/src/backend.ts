import { createHash, randomUUID } from 'node:crypto';
import { decodeCliModels } from 'dsh-claude-ssh/process';
import type { Agent, Cursor, HostConfig, Model, NativeProtocol, PermissionAnswer, Provider, Task, TimelinePage, Workspace } from './domain.js';
import { RemoteError } from './domain.js';
import { connectionInput, JsonlPeer, OpenSshTransport, quote, type SshTransport } from './ssh.js';
import { CliSession, initializeAcp, initializeCodex } from './runtime.js';
import { TaskHistory } from './history.js';
import type { Store } from './store.js';
import { discoverAcpCatalog } from './acp.js';
import { antigravityArguments, ANTIGRAVITY_NOTICE, ANTIGRAVITY_RUNNER, decodeAntigravityModels } from './antigravity.js';
export { connectionInput } from './ssh.js';

export interface Backend {
  /** Agent state and timeline can be read without contacting the execution host. */
  readonly localReads?: boolean;
  connect(): Promise<string>;
  close(): Promise<void>;
  providers(cwd: string, refresh: boolean): Promise<Provider[]>;
  workspaces(): Promise<Workspace[]>;
  create(task: Task): Promise<Agent>;
  recover?(task: Task): Promise<Agent>;
  agent(id: string): Promise<Agent | null>;
  timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
  send(id: string, text: string, messageId: string): Promise<void>;
  stop(id: string): Promise<void>;
  respond(id: string, requestId: string, answer: PermissionAnswer, input?: Record<string, unknown>): Promise<void>;
}
export type BackendFactory = (host: HostConfig) => Backend;
export const CLI_PROVIDERS = [
  { id: 'claude', label: 'Claude Code', command: 'claude', protocol: 'claude' as const, args: [] },
  { id: 'codex', label: 'Codex', command: 'codex', protocol: 'codex' as const, args: ['app-server'] },
  { id: 'dsh', label: 'DSH', command: 'dsh', protocol: 'acp' as const, args: ['--profile', 'acp'] },
  { id: 'antigravity', label: 'Antigravity', command: 'agy', protocol: 'antigravity' as const, args: [] },
  { id: 'grok', label: 'Grok', command: 'grok', protocol: 'acp' as const, args: ['agent', '--no-leader', 'stdio'] },
  { id: 'codebuddy', label: 'CodeBuddy', command: 'codebuddy', protocol: 'acp' as const, args: ['--acp'] },
];
type Profile = { protocol: NativeProtocol; argv: string[]; cwd: string; provider: Provider };
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
export class SshBackend implements Backend {
  readonly localReads = true;
  private readonly transport: SshTransport;
  private closed = false;
  private readonly probes = new Set<JsonlPeer>();
  private identity?: { id: string; at: number };
  private catalogs = new Map<string, { at: number; profiles: Map<string, Profile>; providers: Provider[] }>();
  private sessions = new Map<string, CliSession>();
  private histories = new Map<string, Promise<TaskHistory>>();
  private starting = new Map<string, Promise<Agent>>();
  constructor(private readonly host: HostConfig, private readonly store: Store, transport?: SshTransport) {
    this.transport = transport ?? new OpenSshTransport(connectionInput(host.connection));
  }
  private assertOpen(): void { if (this.closed) throw new Error('SSH task backend has stopped'); }
  async connect(): Promise<string> {
    this.assertOpen();
    if (this.identity && Date.now() - this.identity.at < 15_000) return this.identity.id;
    const identity = await this.transport.exec(`printf '%s\\0%s\\0%s\\0' "$(uname -n)" "$(id -un)" "$(cat /etc/machine-id 2>/dev/null || uname -s)"`);
    const [machine, user, unique] = identity.split('\0');
    if (!machine || !user || !unique) throw new Error('SSH did not report a valid machine identity');
    const id = `ssh-${createHash('sha256').update(JSON.stringify([machine, user, unique])).digest('hex')}`;
    this.identity = { id, at: Date.now() }; return id;
  }
  private async history(id: string): Promise<TaskHistory> {
    let promise = this.histories.get(id);
    if (!promise) { const history = new TaskHistory(this.store.directory, id); promise = history.open().then(() => history); this.histories.set(id, promise); }
    return promise;
  }
  async providers(cwd: string, refresh: boolean): Promise<Provider[]> {
    this.assertOpen();
    const cached = this.catalogs.get(cwd);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return structuredClone(cached.providers);
    const output = await this.transport.exec(`cd ${quote(cwd)} && printf '%s\\0' "$(pwd -P)" && ${CLI_PROVIDERS.map(p => `printf '%s\\0%s\\0' ${quote(p.id)} "$(command -v ${quote(p.command)} 2>/dev/null || true)"`).join(' && ')}`);
    const [canonical, ...parts] = output.split('\0');
    this.assertOpen();
    if (!canonical?.startsWith('/')) throw new Error('Remote project does not exist or is not accessible');
    const installed = new Map<string, string>(); for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i + 1]) installed.set(parts[i], parts[i + 1]);
    const profiles = new Map<string, Profile>();
    const providers = await Promise.all(CLI_PROVIDERS.map(async definition => {
      const path = installed.get(definition.id);
      const unavailable: Provider = { id: definition.id, label: definition.label, status: 'unavailable', models: [], modes: [], ...(definition.id === 'antigravity' ? { notice: ANTIGRAVITY_NOTICE } : {}) };
      if (!path) return unavailable;
      let peer: JsonlPeer | undefined;
      try {
        const argv = [path, ...definition.args];
        if (definition.protocol === 'antigravity') {
          const version = await this.transport.exec('node --version');
          if (Number(version.trim().match(/^v(\d+)/)?.[1] ?? 0) < 22) throw new Error('Antigravity remote control requires Node.js 22 or newer on the SSH host');
          const models = decodeAntigravityModels(await this.transport.exec(`cd ${quote(canonical)} && ${quote(path)} models`, 40_000));
          if (!models.length) throw new Error('Antigravity returned no models. Sign in with agy and check agy models on the remote host.');
          const provider: Provider = { ...unavailable, status: 'ready', models, defaultModeId: 'default', modes: [{ id: 'default', label: 'CLI permission settings' }, { id: 'plan', label: 'Plan' }, { id: 'accept-edits', label: 'Accept edits' }, { id: 'auto', label: 'Auto' }] };
          profiles.set(definition.id, { argv, protocol: definition.protocol, cwd: canonical, provider }); return provider;
        }
        const launch = definition.protocol === 'claude' ? [path, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'] : argv;
        this.assertOpen();
        peer = new JsonlPeer(this.transport.start(canonical, launch)); this.probes.add(peer);
        peer.onMessage(message => { if (message.method && message.id !== undefined) peer?.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Discovery does not execute tools' } }); });
        let models: Model[] = [], modes: Provider['modes'] = [], defaultModeId: string | undefined;
        if (definition.protocol === 'codex') {
          await initializeCodex(peer);
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const result = await peer.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
            models.push(...list(result?.data).filter(m => !m.hidden).map(m => ({ id: String(m.model ?? m.id), label: String(m.displayName ?? m.model ?? m.id), isDefault: m.isDefault === true, defaultThinkingOptionId: m.defaultReasoningEffort, thinkingOptions: list(m.supportedReasoningEfforts).map(e => ({ id: String(e.reasoningEffort), label: String(e.reasoningEffort) })) })));
            cursor = result?.nextCursor; if (!cursor) break;
          }
          modes = [{ id: 'workspace-write', label: 'Workspace write · ask on request' }, { id: 'read-only', label: 'Read only' }, { id: 'full-access', label: 'Full access' }]; defaultModeId = 'workspace-write';
        } else if (definition.protocol === 'claude') {
          await peer.control({ subtype: 'initialize' });
          const result = await peer.control({ subtype: 'list_models' });
          models = decodeCliModels(result).map(m => ({ id: m.value, label: m.displayName, thinkingOptions: m.efforts.map(id => ({ id, label: id })) }));
          modes = [{ id: 'default', label: 'Ask before tools' }, { id: 'plan', label: 'Plan' }, { id: 'acceptEdits', label: 'Accept edits' }, { id: 'bypassPermissions', label: 'Full access' }]; defaultModeId = 'default';
        } else {
          const capabilities = await initializeAcp(peer);
          const session = await peer.request('session/new', { cwd: canonical, mcpServers: [] });
          ({ models, modes, defaultModeId } = await discoverAcpCatalog(peer, session));
          if (capabilities.agentCapabilities?.sessionCapabilities?.close) await peer.request('session/close', { sessionId: session.sessionId });
        }
        models = [...new Map(models.filter(m => m.id && m.id !== 'undefined').map(m => [m.id, m])).values()];
        if (!models.length) throw new Error('The remote CLI returned no models. Check its login and version.');
        const provider: Provider = { ...unavailable, status: 'ready', models, modes, defaultModeId };
        profiles.set(definition.id, { argv, protocol: definition.protocol, cwd: canonical, provider }); return provider;
      } catch (error) { return { ...unavailable, status: 'error' as const, error: error instanceof Error ? error.message : String(error) }; }
      finally { if (peer) { this.probes.delete(peer); peer.close(); } }
    }));
    this.assertOpen();
    this.catalogs.set(cwd, { at: Date.now(), profiles, providers }); return structuredClone(providers);
  }
  async workspaces(): Promise<Workspace[]> {
    const paths = new Set(this.store.snapshot().tasks.filter(t => t.hostId === this.host.id).map(t => t.executionCwd ?? t.cwd));
    return [...paths].map(path => ({ id: createHash('sha256').update(path).digest('hex').slice(0, 16), name: path.split('/').filter(Boolean).at(-1) ?? path, path }));
  }
  private task(id: string): Task {
    const task = this.store.snapshot().tasks.find(t => t.agentId === id && t.hostId === this.host.id);
    if (!task) throw new RemoteError('Remote task not found', 404); return task;
  }
  async create(task: Task): Promise<Agent> { return this.start(task, false); }
  async recover(task: Task): Promise<Agent> { return this.start(task, true); }
  private async start(task: Task, resume: boolean): Promise<Agent> {
    this.assertOpen();
    const existing = this.sessions.get(task.id);
    if (existing?.alive && existing.agent.status !== 'error' && existing.agent.status !== 'closed') return structuredClone(existing.agent);
    const pending = this.starting.get(task.id); if (pending) return pending;
    const operation = this.open(task, resume); this.starting.set(task.id, operation);
    try { return await operation; } finally { this.starting.delete(task.id); }
  }
  private async open(task: Task, resume: boolean): Promise<Agent> {
    if (!CLI_PROVIDERS.some(provider => provider.id === task.provider)) throw new Error('This CLI provider is no longer supported. Saved output remains available.');
    this.sessions.get(task.id)?.close();
    let profile: Profile;
    if (resume) {
      if (!task.native) throw new Error('No saved native CLI session exists. The task will not be replayed.');
      profile = { protocol: task.native.protocol, argv: task.native.argv, cwd: task.executionCwd ?? task.cwd, provider: { id: task.provider, label: task.provider, status: 'ready', models: [], modes: [] } };
    } else {
      await this.providers(task.cwd, false);
      const found = this.catalogs.get(task.cwd)?.profiles.get(task.provider);
      if (!found) throw new Error('The selected CLI is not ready on this SSH host'); profile = found;
    }
    let argv = [...profile.argv];
    if (profile.protocol === 'antigravity') argv = antigravityArguments(argv[0], task, resume);
    if (profile.protocol === 'claude') argv = [argv[0], '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--model', task.model, ...(resume ? ['--resume', task.native!.sessionId] : ['--session-id', randomUUID()]), '--permission-mode', task.modeId ?? 'default', ...(task.thinkingOptionId ? ['--effort', task.thinkingOptionId] : [])];
    const history = await this.history(task.id);
    this.assertOpen();
    if ([...this.sessions.values()].filter(s => s.alive).length >= 8) {
      const idle = [...this.sessions].find(([id, session]) => !this.starting.has(id) && session.evictable);
      if (!idle) throw new Error('This SSH host already has eight open CLI sessions');
      idle[1].close(); this.sessions.delete(idle[0]);
    }
    const launch = profile.protocol === 'antigravity' ? ['node', '--input-type=module', '-e', ANTIGRAVITY_RUNNER, '--', ...argv] : argv;
    const session = new CliSession(new JsonlPeer(this.transport.start(profile.cwd, launch)), { ...task, executionCwd: profile.cwd }, history, this.store);
    this.sessions.set(task.id, session);
    try {
      await session.initialize(profile.protocol, argv, resume);
      this.assertOpen();
      if (!resume) await session.send(task.prompt, task.id);
      return structuredClone(session.agent);
    } catch (error) { session.close(); throw error; }
  }
  async agent(id: string): Promise<Agent | null> {
    const task = this.task(id), session = this.sessions.get(task.id);
    if (session) return structuredClone(session.agent);
    return { id, cwd: task.executionCwd ?? task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'closed', pendingPermissions: [], nativeSessionId: task.native?.sessionId, lastError: 'The CLI process is not attached. Reconnect the saved session to continue; the previous prompt will not be replayed.' };
  }
  async timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage> { return (await this.history(this.task(id).id)).page(cursor, direction); }
  private session(id: string): CliSession {
    const taskId = this.task(id).id, session = this.sessions.get(taskId);
    if (!session?.alive) throw new Error('Reconnect the saved CLI session before continuing');
    this.sessions.delete(taskId); this.sessions.set(taskId, session);
    return session;
  }
  async send(id: string, text: string, messageId: string): Promise<void> { await this.session(id).send(text, messageId); }
  async stop(id: string): Promise<void> { await this.session(id).stop(); }
  async respond(id: string, requestId: string, answer: PermissionAnswer): Promise<void> { await this.session(id).respond(requestId, answer); }
  async close(): Promise<void> {
    this.closed = true;
    for (const probe of this.probes) probe.close();
    for (const session of this.sessions.values()) session.close();
    await Promise.allSettled([...this.starting.values()]);
    this.probes.clear(); this.sessions.clear();
    for (const history of this.histories.values()) await (await history).flush();
  }
}
