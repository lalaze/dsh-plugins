import { join } from 'node:path';
import { permissionOf } from '../core/dsh-host.js';
import { dshHome, under, WorkspaceAccess } from './access.js';
import { editorHandler } from './editor-route.js';
import { workspaceTransferHandler } from './http.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { WorkspaceService } from './service.js';
import { installWorkspaceTerminal } from './terminal.js';
import { workspaceTools } from './tools.js';
import { WorkspaceTunnels } from './tunnels.js';
/**
 * Remote workspace tools on the saved machines: files, sync, tunnels, the native terminal's Remote workspace shell, the
 * `remote_workspace` tool and its system prompt. The caller closes `features.tunnels`.
 */
export async function installWorkspaces(ctx, store, machines) {
    const access = new WorkspaceAccess(() => store.hosts(), { runtime: () => ctx.get('subprocess') });
    const workspaces = new RemoteWorkspaces(machines, access);
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
        const cwd = await sessionCwd(id), value = await access.resolve(cwd, signal);
        return cwd === await sessionCwd(id) ? value : { hostIds: [] };
    };
    const files = new WorkspaceService(machines, placement, sessionCwd);
    const unbounded = () => new AbortController().signal;
    ctx.provide('remoteAgentsWorkspaces', {
        gitWorkspaceVersion: 1,
        target: (id, signal = unbounded()) => files.target(id, signal),
        git: (id, batch, signal = unbounded(), expected) => files.git(id, batch, signal, expected),
        cancelGit: (id, job, signal = unbounded(), expected) => files.cancelGit(id, job, signal, expected),
        stat: async (id, path, signal = unbounded(), expected) => await files.operate(id, { op: 'stat', path }, signal, expected),
        download: (id, path, revision, signal = unbounded(), expected) => files.download(id, path, revision, signal, expected),
        upload: async (id, path, revision, data, signal = unbounded(), expected) => await files.upload(id, path, revision, data.length, (async function* () { yield data; })(), signal, expected),
    });
    const tunnels = new WorkspaceTunnels(join(store.directory, 'workspace-tunnels.json'), () => store.hosts());
    await tunnels.open();
    const terminal = {};
    // Uploads stream; downloads need their own buffered route, because DSH builds every request of a streaming route
    // with the request stream as its body, and a GET request with a body cannot be built.
    const transfer = workspaceTransferHandler(files);
    ctx.connection.fetch.register({ path: '/api/remote-agents/files', methods: ['POST'], requestBody: 'streaming', fetch: transfer });
    ctx.connection.fetch.register({ path: '/api/remote-agents/download', methods: ['GET'], requestBody: 'buffered', fetch: transfer });
    // The client's EDITOR_SRC; the build writes the bundle next to lib/server.
    ctx.connection.fetch.register({ path: '/api/remote-agents/editor.js', methods: ['GET'], requestBody: 'buffered', fetch: editorHandler(new URL('../../editor.js', import.meta.url)) });
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
    ctx.inject(['tools', 'approval', 'userQuestions'], scoped => {
        const host = scoped;
        for (const tool of workspaceTools(files, host, agent => permissionOf(scoped, agent?.session)))
            host.tools.register(tool);
    });
    return { access, placement, workspaces, features: { files, tunnels, terminal } };
}
