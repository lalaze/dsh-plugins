import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { RemoteAgentsService } from './service.js';
import { createHandler } from './http.js';
import { delegationTools } from './tools.js';
import { ChatProjects } from './chat-projects.js';
import { CHAT_PROVIDERS, RemoteCliAdapter } from './native-chat.js';
import { WorkspaceAccess } from './workspace-access.js';
export const name = 'dsh-remote-agents';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()) });
export async function apply(ctx, config = {}) {
    const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
    await store.open();
    const service = new RemoteAgentsService(store);
    const projects = new ChatProjects(service);
    const workspace = new WorkspaceAccess(() => store.hosts(), { runtime: () => ctx.get('subprocess') });
    const sessionCwd = async (sessionId) => {
        const sessions = ctx.get('sessions');
        const live = () => sessions?.get?.(sessionId);
        const attached = live();
        if (attached)
            return attached.header.cwd;
        const persistence = ctx.get('sessionPersistence');
        const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
        const activated = live();
        return activated ? activated.header.cwd : stored?.cwd;
    };
    ctx.effect(() => () => service.close());
    ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(service, projects, async (id, signal) => {
            const cwd = await sessionCwd(id), placement = await workspace.resolve(cwd, signal);
            return cwd === await sessionCwd(id) ? placement : { hostIds: [] };
        }) });
    ctx.inject(['llm', 'sessions', 'agents', 'approval', 'userQuestions'], scoped => {
        const host = scoped;
        const steps = new Map();
        scoped.on('session/event', (session, event) => {
            if (event.type === 'step/start')
                steps.set(session.id, { session, ...event.data });
            else if (event.type === 'step/end' || event.type === 'turn/end')
                steps.delete(session.id);
        }, { global: true });
        const adapter = new RemoteCliAdapter(projects, { approval: host.approval, userQuestions: host.userQuestions,
            agent: id => host.agents.get(id), step: id => steps.get(id), cwd: id => steps.get(id)?.session.header.cwd ?? scoped.sessions.get(id)?.header.cwd,
            userContent: (id, messageId) => (steps.get(id)?.session ?? scoped.sessions.get(id))?.deriveMessages().find(m => m.id === messageId && m.role === 'user' && (!m.source || m.source.kind === 'user'))?.content,
            attachments: {
                image: async (ref, signal) => {
                    const storage = scoped.get('attachments');
                    if (!storage)
                        throw new Error('The DSH attachment service is unavailable');
                    return storage.readImageRequest(ref, { width: Math.min(ref.width, 1568), height: Math.min(ref.height, 1568), maxBytes: 4 * 1024 * 1024 }, signal);
                },
                file: async function* (ref, signal) {
                    const storage = scoped.get('attachments');
                    if (!storage)
                        throw new Error('The DSH attachment service is unavailable');
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
        const host = scoped;
        for (const tool of delegationTools(host, service))
            host.tools.register(tool);
    });
}
