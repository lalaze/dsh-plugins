import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { RemoteAgentsService } from './service.js';
import { createHandler } from './http.js';
import { delegationTools } from './tools.js';
import { ChatProjects } from './chat-projects.js';
import { CHAT_IMAGE_LIMIT } from './chat-images.js';
import { CHAT_PROVIDERS, RemoteCliAdapter } from './native-chat.js';
import { WorkspaceAccess } from './workspace-access.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { remoteUsageRecord } from './usage.js';
import { WorkspaceService } from './workspace-service.js';
import { WorkspaceTunnels } from './workspace-tunnels.js';
import { WorkspaceMigration } from './workspace-migration.js';
import { workspaceTransferHandler } from './workspace-http.js';
import { installWorkspaceTerminal } from './workspace-terminal.js';
import { workspaceTools } from './workspace-tools.js';
import { dshHome, under } from './workspace-access.js';
export const name = 'dsh-remote-agents';
export const inject = ['connection'];
const stateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
/** A conversation's preset (composer or /permission), mapped through its sandbox so renamed presets still match; `custom` has no mapping. */
function permissionOf(ctx, session) {
    const presets = ctx.get('permissionPresets');
    if (!presets || !session)
        return;
    const preset = presets.current(session);
    if (preset === 'auto')
        return 'auto';
    try {
        return presets.resolve(preset).sandbox;
    }
    catch {
        return;
    }
}
export const Config = Schema.object({ stateDir: Schema.string().default(stateDir()) });
export async function apply(ctx, config = {}) {
    const store = new Store(join(config.stateDir ?? stateDir(), 'state.json'));
    await store.open();
    const service = new RemoteAgentsService(store);
    const projects = new ChatProjects(service);
    const workspace = new WorkspaceAccess(() => store.hosts(), { runtime: () => ctx.get('subprocess') });
    const workspaces = new RemoteWorkspaces(service, workspace);
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
    const placement = async (id, signal) => {
        const cwd = await sessionCwd(id), value = await workspace.resolve(cwd, signal);
        return cwd === await sessionCwd(id) ? value : { hostIds: [] };
    };
    const files = new WorkspaceService(service, placement, sessionCwd);
    const tunnels = new WorkspaceTunnels(join(store.directory, 'workspace-tunnels.json'), () => store.hosts());
    await tunnels.open();
    const terminal = {};
    const features = { files, tunnels, migration: new WorkspaceMigration(service), terminal };
    // Close the store last: a reloaded plugin's new instance owns the state from then on.
    ctx.effect(() => async () => { await tunnels.close(); await service.close(); await store.close(); });
    // Every finished turn is announced for usage statistics. Main chat does not report usage to DSH: a CLI turn's total
    // spans many model calls and would misstate the conversation's context size.
    store.usageListeners.add((taskId, usage, turn) => {
        const task = store.task(t => t.id === taskId);
        if (task)
            ctx.emit('remote-agents/usage', remoteUsageRecord(task, store.hosts(), usage, turn));
    });
    // Persistent CLIs kept running while DSH was away; reattach and catch up in the background.
    void service.resume();
    ctx.connection.fetch.register({ path: '/api/remote-agents', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createHandler(service, projects, placement, workspaces, features) });
    ctx.connection.fetch.register({ path: '/api/remote-agents/files', methods: ['GET', 'POST'], requestBody: 'streaming', fetch: workspaceTransferHandler(files) });
    ctx.inject(['terminalController'], scoped => {
        let disposed = false, cleanup;
        void installWorkspaceTerminal(scoped.get('terminalController'), join(store.directory, 'terminal'), join(store.directory, 'state.json'))
            .then(({ shell, dispose }) => { if (disposed)
            dispose();
        else {
            cleanup = () => { delete terminal.shell; dispose(); };
            terminal.shell = shell;
        } })
            .catch(error => scoped.get('logger')?.warn?.(`Remote workspace terminal unavailable: ${String(error)}`));
        scoped.effect(() => () => { disposed = true; cleanup?.(); });
    });
    ctx.inject(['systemPrompt'], scoped => {
        scoped.get('systemPrompt').section({ name: 'remote-agents-workspace', order: 88,
            text: ({ agent }) => {
                const cwd = agent?.session?.header?.cwd;
                return cwd && under(join(dshHome(), 'remote-workspaces'), cwd)
                    ? 'Remote workspace: the local directory is an anchor, not the project files. Use remote_workspace to list, read, search, edit and run commands in this conversation’s verified remote directory. Read remote AGENTS.md before making changes. Local filesystem and shell tools act on the DSH host; do not use them for remote project work.' : '';
            } });
    });
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
            permission: id => permissionOf(scoped, steps.get(id)?.session ?? scoped.sessions.get(id)),
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
            image: async (id, path, signal) => {
                const file = await files.operate(id, { op: 'stat', path }, signal);
                return file.size <= CHAT_IMAGE_LIMIT ? files.download(id, path, file.revision, signal) : undefined;
            },
            workspace: (cwd, signal) => workspace.resolve(cwd, signal) });
        const registration = scoped.llm.registerAdapter(CHAT_PROVIDERS, adapter);
        scoped.effect(() => projects.onChange(() => registration.replace(CHAT_PROVIDERS)));
        // A model's remembered reasoning effort is its advertised default; DSH reloads the catalog on replace.
        scoped.effect(() => adapter.onModelInfoChange(() => registration.replace(CHAT_PROVIDERS)));
        scoped.effect(() => () => adapter.close());
    });
    // Native conversation routes and settings also work without the delegation tool registry.
    ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
        const host = scoped;
        for (const tool of delegationTools(host, service))
            host.tools.register(tool);
        for (const tool of workspaceTools(files, host, agent => permissionOf(scoped, agent?.session)))
            host.tools.register(tool);
    });
}
