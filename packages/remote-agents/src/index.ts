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
import { CHAT_PROVIDERS, RemoteCliAdapter } from './native-chat.js';
import type { Session } from '@deepseek-ai/dsh-session';
import type { DshPermission } from './domain.js';
import { WorkspaceAccess, type WorkspaceRuntime } from './workspace-access.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { remoteUsageRecord, type RemoteUsageRecord } from './usage.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Every finished remote CLI turn: main-chat replies, delegated agents and turns sent from the sessions panel. */
    'remote-agents/usage'(record: RemoteUsageRecord): void;
  }
}

export const name = 'dsh-remote-agents';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()) });
export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
  await store.open();
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
  // Close the store last: a reloaded plugin's new instance owns the state from then on.
  ctx.effect(() => async () => { await service.close(); await store.close(); });
  // Every finished turn is announced for usage statistics. Main chat does not report usage to DSH: a CLI turn's total
  // spans many model calls and would misstate the conversation's context size.
  store.usageListeners.add((taskId, usage, turn) => {
    const task = store.task(t => t.id === taskId);
    if (task) ctx.emit('remote-agents/usage', remoteUsageRecord(task, store.hosts(), usage, turn));
  });
  // Persistent CLIs kept running while DSH was away; reattach and catch up in the background.
  void service.resume();
  ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(service, projects, async (id, signal) => {
    const cwd = await sessionCwd(id), placement = await workspace.resolve(cwd, signal);
    return cwd === await sessionCwd(id) ? placement : { hostIds: [] };
  }, workspaces) });
  ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { agents: { get(id: string): unknown } };
    const steps = new Map<string, { session: Session; turn: number; step: number }>();
    scoped.on('session/event', (session, event) => {
      if (event.type === 'step/start') steps.set(session.id, { session, ...event.data });
      else if (event.type === 'step/end' || event.type === 'turn/end') steps.delete(session.id);
    }, { global: true });
    const adapter = new RemoteCliAdapter(projects, { approval: host.approval, userQuestions: host.userQuestions,
      agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => steps.get(id)?.session.header.cwd ?? scoped.sessions.get(id)?.header.cwd,
      permission: id => {
        // The composer's preset, mapped through its sandbox so renamed presets still match; `custom` has no mapping.
        const presets = scoped.get('permissionPresets') as { current(session: Session): string; resolve(name: string): { sandbox: DshPermission } } | undefined;
        const session = steps.get(id)?.session ?? scoped.sessions.get(id);
        if (!presets || !session) return;
        const preset = presets.current(session);
        if (preset === 'auto') return 'auto';
        try { return presets.resolve(preset).sandbox; } catch { return; }
      },
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
      workspace: (cwd, signal) => workspace.resolve(cwd, signal) });
    const registration = scoped.llm.registerAdapter(CHAT_PROVIDERS, adapter);
    scoped.effect(() => projects.onChange(() => registration.replace(CHAT_PROVIDERS)));
    scoped.effect(() => () => adapter.close());
  });
  // Native conversation routes and settings also work without the delegation tool registry.
  ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { tools: { register(tool: ToolDefinition): unknown } };
    for (const tool of delegationTools(host, service)) host.tools.register(tool);
  });
}
