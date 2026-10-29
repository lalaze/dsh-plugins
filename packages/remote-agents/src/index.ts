import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { RemoteAgentsService } from './service.js';
import { createHandler } from './http.js';
import { delegationTools, type ToolDefinition, type ToolHost } from './tools.js';
import { ChatProjects } from './chat-projects.js';
import { CHAT_IMAGE_LIMIT } from './chat-images.js';
import { CHAT_PROVIDERS, RemoteCliAdapter, type SyncAgent } from './native-chat.js';
import type { Session } from '@deepseek-ai/dsh-session';
import type { DshPermission } from './domain.js';
import { WorkspaceAccess, type WorkspaceRuntime } from './workspace-access.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { remoteUsageRecord, type RemoteUsageRecord } from './usage.js';
import { WorkspaceService } from './workspace-service.js';
import { WorkspaceTunnels } from './workspace-tunnels.js';
import { workspaceTransferHandler } from './workspace-http.js';
import { installWorkspaceTerminal } from './workspace-terminal.js';
import { workspaceTools } from './workspace-tools.js';
import { dshHome, under } from './workspace-access.js';
import { Sharing, type SharingAttachments, type SharingSkills, type SharingTools } from './sharing.js';
import { repairStoredSessions } from './session-repair.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Every finished remote CLI turn: main-chat replies, delegated agents and turns sent from the sessions panel. */
    'remote-agents/usage'(record: RemoteUsageRecord): void;
    /** Emitted by DSH's agent registry for each new or resumed conversation agent. */
    'agent/created'(payload: { agent: SyncAgent }): undefined | Promise<undefined>;
    /** Emitted by DSH's tool registry when a tool is registered or unregistered. */
    'tools/change'(): void;
  }
}

export const name = 'dsh-remote-agents';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
/** A conversation's preset (composer or /permission), mapped through its sandbox so renamed presets still match; `custom` has no mapping. */
function permissionOf(ctx: Context, session: Session | undefined): DshPermission | undefined {
  const presets = ctx.get('permissionPresets') as { current(session: Session): string; resolve(name: string): { sandbox: DshPermission } } | undefined;
  if (!presets || !session) return;
  const preset = presets.current(session);
  if (preset === 'auto') return 'auto';
  try { return presets.resolve(preset).sandbox; } catch { return; }
}
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()) });
export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
  await store.open();
  const logger = () => ctx.get('logger') as { info?(text: string): void; warn?(text: string): void } | undefined;
  // Conversations saved by 0.2.53 and earlier stored a remote tool row out of order, and DSH refuses to reopen them.
  const persistence = ctx.get('sessionPersistence') as { root?: unknown } | undefined;
  const open = (id: string) => !!(ctx.get('sessions') as { get?(id: string): unknown } | undefined)?.get?.(id);
  void repairStoredSessions(typeof persistence?.root === 'string' ? persistence.root : join(dshHome(), 'sessions'), store.directory, open)
    .then(paths => { if (paths.length) logger()?.info?.(`Repaired ${paths.length} remote CLI conversation log(s) DSH could not reopen; originals kept in ${join(store.directory, 'session-backups')}`); })
    .catch(error => logger()?.warn?.(`Remote CLI conversation repair failed: ${String(error)}`));
  const service = new RemoteAgentsService(store);
  const projects = new ChatProjects(service);
  const workspace = new WorkspaceAccess(() => store.hosts(), { runtime: () => ctx.get('subprocess') as WorkspaceRuntime | undefined });
  const workspaces = new RemoteWorkspaces(service, workspace);
  const sessionCwd = async (sessionId: string): Promise<string | undefined> => {
    const sessions = ctx.get('sessions') as { get?(id: string): { header: { cwd?: string } } | undefined } | undefined;
    const live = () => sessions?.get?.(sessionId);
    const attached = live();
    if (attached) return attached.header.cwd;
    const persistence = ctx.get('sessionPersistence') as { list(): Promise<({ id: string; cwd?: string } | { header: { id: string; cwd?: string } })[]> } | undefined;
    const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
    const activated = live();
    return activated ? activated.header.cwd : stored?.cwd;
  };
  const placement = async (id: string, signal: AbortSignal) => {
    const cwd = await sessionCwd(id), value = await workspace.resolve(cwd, signal);
    return cwd === await sessionCwd(id) ? value : { hostIds: [] };
  };
  const files = new WorkspaceService(service, placement, sessionCwd);
  const tunnels = new WorkspaceTunnels(join(store.directory, 'workspace-tunnels.json'), () => store.hosts());
  await tunnels.open();
  const terminal: { shell?: string } = {};
  const features = { files, tunnels, terminal };
  const sharing = new Sharing(store, undefined, message => (ctx.get('logger') as { warn?(text: string): void } | undefined)?.warn?.(message));
  service.sharing = sharing;
  // Close the store last: a reloaded plugin's new instance owns the state from then on.
  ctx.effect(() => async () => { await sharing.close(); await tunnels.close(); await service.close(); await store.close(); });
  // Every finished turn is announced for usage statistics. Main chat does not report usage to DSH: a CLI turn's total
  // spans many model calls and would misstate the conversation's context size.
  store.usageListeners.add((taskId, usage, turn) => {
    const task = store.task(t => t.id === taskId);
    if (task) ctx.emit('remote-agents/usage', remoteUsageRecord(task, store.hosts(), usage, turn));
  });
  // Persistent CLIs kept running while DSH was away; reattach and catch up in the background.
  const resumed = service.resume();
  ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(service, projects, placement, workspaces, features, sharing) });
  ctx.connection.fetch.register({ path: '/api/remote-agents/files', methods: ['GET', 'POST'], requestBody: 'streaming', fetch: workspaceTransferHandler(files) });
  ctx.inject(['terminalController'], scoped => {
    let disposed = false, cleanup: (() => void) | undefined;
    void installWorkspaceTerminal(scoped.get('terminalController'), join(store.directory, 'terminal'), join(store.directory, 'state.json'))
      .then(({ shell, dispose }) => { if (disposed) dispose(); else { cleanup = () => { delete terminal.shell; dispose(); }; terminal.shell = shell; } })
      .catch(error => scoped.get('logger')?.warn?.(`Remote workspace terminal unavailable: ${String(error)}`));
    scoped.effect(() => () => { disposed = true; cleanup?.(); });
  });
  ctx.inject(['systemPrompt'], scoped => {
    (scoped.get('systemPrompt') as { section(value: unknown): void }).section({ name: 'remote-agents-workspace', order: 88,
      text: ({ agent }: { agent?: { session?: { header?: { cwd?: string } } } }) => {
        const cwd = agent?.session?.header?.cwd;
        return cwd && under(join(dshHome(), 'remote-workspaces'), cwd)
          ? 'Remote workspace: the local directory is an anchor, not the project files. Use remote_workspace to list, read, search, edit and run commands in this conversation’s verified remote directory. Read remote AGENTS.md before making changes. Local filesystem and shell tools act on the DSH host; do not use them for remote project work.' : '';
      } });
  });
  ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { agents: { get(id: string): unknown; list?(): SyncAgent[] } };
    const steps = new Map<string, { session: Session; turn: number; step: number }>();
    scoped.on('session/event', (session, event) => {
      if (event.type === 'step/start') steps.set(session.id, { session, ...event.data });
      else if (event.type === 'step/end' || event.type === 'turn/end') steps.delete(session.id);
    }, { global: true });
    const adapter = new RemoteCliAdapter(projects, { approval: host.approval, userQuestions: host.userQuestions,
      agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => steps.get(id)?.session.header.cwd ?? scoped.sessions.get(id)?.header.cwd,
      permission: id => permissionOf(scoped, steps.get(id)?.session ?? scoped.sessions.get(id)),
      userContent: (id, messageId) => (steps.get(id)?.session ?? scoped.sessions.get(id))?.deriveMessages().find(m => m.id === messageId && m.role === 'user' && (!m.source || m.source.kind === 'user'))?.content,
      attachments: {
        image: async (ref, signal) => {
          const storage = scoped.get('attachments');
          if (!storage) throw new Error('The DSH attachment service is unavailable');
          return storage.readImageRequest(ref, { width: Math.min(ref.width, 1568), height: Math.min(ref.height, 1568), maxBytes: 4 * 1024 * 1024 }, signal);
        },
        file: async function* (ref, signal) {
          const storage = scoped.get('attachments');
          if (!storage) throw new Error('The DSH attachment service is unavailable');
          yield* storage.readFileStream(ref, signal);
        },
      },
      image: async (id, path, signal) => {
        const file = await files.operate(id, { op: 'stat', path }, signal) as { revision: string; size: number };
        return file.size <= CHAT_IMAGE_LIMIT ? files.download(id, path, file.revision, signal) : undefined;
      },
      workspace: (cwd, signal) => workspace.resolve(cwd, signal) });
    const registration = scoped.llm.registerAdapter(CHAT_PROVIDERS, adapter);
    scoped.effect(() => projects.onChange(() => registration.replace(CHAT_PROVIDERS)));
    // A model's remembered reasoning effort is its advertised default; DSH reloads the catalog on replace.
    scoped.effect(() => adapter.onModelInfoChange(() => registration.replace(CHAT_PROVIDERS)));
    scoped.effect(() => () => adapter.close());
    // A response cut off by quitting DSH or reloading the plugin catches up by itself once its CLI is reattached:
    // when DSH opens the conversation, or right away for conversations already open.
    const wake = (agent: SyncAgent) => { void resumed.then(() => adapter.sync(agent)).catch(() => {}); };
    scoped.on('agent/created', ({ agent }) => { wake(agent); return undefined; }, { global: true });
    for (const agent of host.agents.list?.() ?? []) wake(agent);
  });
  // Shared MCP calls run through DSH's tool pipeline with the owning conversation's agent; skills come from its registry.
  ctx.inject(['tools'], scoped => {
    sharing.host.tools = scoped.get('tools') as unknown as SharingTools;
    // An MCP server connecting or dropping changes the tools its proxies list.
    scoped.on('tools/change', () => sharing.toolsChanged());
    scoped.effect(() => () => { delete sharing.host.tools; });
  });
  ctx.inject(['skills'], scoped => {
    sharing.host.skills = scoped.get('skills') as unknown as SharingSkills;
    scoped.effect(() => () => { delete sharing.host.skills; });
  });
  // Images in shared MCP results are sent as the attachments DSH's policies left.
  ctx.inject(['attachments'], scoped => {
    sharing.host.attachments = scoped.get('attachments') as unknown as SharingAttachments;
    scoped.effect(() => () => { delete sharing.host.attachments; });
  });
  ctx.inject(['agents'], scoped => {
    const agents = scoped.get('agents') as { get(id: string): unknown };
    sharing.host.agent = id => agents.get(id);
    scoped.effect(() => () => { delete sharing.host.agent; });
  });
  // Native conversation routes and settings also work without the delegation tool registry.
  ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { tools: { register(tool: ToolDefinition): unknown } };
    for (const tool of delegationTools(host, service)) host.tools.register(tool);
    for (const tool of workspaceTools(files, host, agent => permissionOf(scoped, (agent as { session?: Session } | undefined)?.session))) host.tools.register(tool);
  });
}
