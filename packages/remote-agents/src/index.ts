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

export const name = 'dsh-remote-agents';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()) });
export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
  await store.open();
  const service = new RemoteAgentsService(store);
  const projects = new ChatProjects(service);
  ctx.effect(() => () => service.close());
  ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(service, projects) });
  ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
    const host = scoped as unknown as ToolHost & { agents: { get(id: string): unknown } };
    const steps = new Map<string, { session: Session; turn: number; step: number }>();
    scoped.on('session/event', (session, event) => {
      if (event.type === 'step/start') steps.set(session.id, { session, ...event.data });
      else if (event.type === 'step/end' || event.type === 'turn/end') steps.delete(session.id);
    }, { global: true });
    const adapter = new RemoteCliAdapter(projects, { approval: host.approval, userQuestions: host.userQuestions,
      agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => steps.get(id)?.session.header.cwd ?? scoped.sessions.get(id)?.header.cwd });
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
