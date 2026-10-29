import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RemoteAgentsService } from './agents/service.js';
import { delegationTools } from './agents/tools.js';
import { remoteUsageRecord, type RemoteUsageRecord } from './agents/usage.js';
import { installChat, scheduleSessionRepair } from './chat/install.js';
import { ChatProjects } from './chat/projects.js';
import type { SyncAgent } from './chat/native-chat.js';
import { loggerOf, type ToolDefinition, type ToolHost } from './core/dsh-host.js';
import { Store } from './core/store.js';
import { createHandler } from './http.js';
import { installSharingHost } from './sharing/install.js';
import { Sharing } from './sharing/sharing.js';
import { installWorkspaces } from './workspace/install.js';

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
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()) });
export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
  await store.open();
  scheduleSessionRepair(ctx, store);
  const service = new RemoteAgentsService(store);
  const projects = new ChatProjects(service);
  const workspace = await installWorkspaces(ctx, store, service);
  const sharing = new Sharing(store, undefined, message => loggerOf(ctx)?.warn?.(message));
  service.sharing = sharing;
  // Close the store last: a reloaded plugin's new instance owns the state from then on.
  ctx.effect(() => async () => { await sharing.close(); await workspace.features.tunnels.close(); await service.close(); await store.close(); });
  // Every finished turn is announced for usage statistics. Main chat does not report usage to DSH: a CLI turn's total
  // spans many model calls and would misstate the conversation's context size.
  store.usageListeners.add((taskId, usage, turn) => {
    const task = store.task(t => t.id === taskId);
    if (task) ctx.emit('remote-agents/usage', remoteUsageRecord(task, store.hosts(), usage, turn));
  });
  ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: createHandler(service, projects, workspace.placement, workspace.workspaces, workspace.features, sharing) });
  installChat(ctx, service, projects, { access: workspace.access, files: workspace.features.files });
  installSharingHost(ctx, sharing);
  // Native conversation routes and settings also work without the delegation tool registry.
  ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { tools: { register(tool: ToolDefinition): unknown } };
    for (const tool of delegationTools(host, service)) host.tools.register(tool);
  });
}
