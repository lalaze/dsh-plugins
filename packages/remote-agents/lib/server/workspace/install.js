import { join } from 'node:path';
import { permissionOf } from '../core/dsh-host.js';
import { sharesSessions } from '../core/domain.js';
import { dshHome, under, WorkspaceAccess } from './access.js';
import { editorHandler } from './editor-route.js';
import { workspaceTransferHandler } from './http.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { WorkspaceTagSync } from './tag-sync.js';
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
        list: async (id, path, signal = unbounded(), expected) => await files.operate(id, { op: 'list', path }, signal, expected),
        remove: async (id, path, revision, signal = unbounded(), expected) => await files.operate(id, { op: 'remove', path, revision }, signal, expected),
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
    installTagSync(ctx, store, machines, access);
    return { access, placement, workspaces, features: { files, tunnels, terminal } };
}
/** Workspace Tags follow a remote workspace to every DSH sharing its machine. */
function installTagSync(ctx, store, machines, access) {
    const root = join(dshHome(), 'remote-workspaces');
    const listed = new Map();
    const placements = new Map();
    const sync = new WorkspaceTagSync(store, {
        tags: () => ctx.get('workspaceTags'),
        workspaces: () => [...listed.values()],
        targets: async (path) => {
            // Only this plugin's anchors stand for a remote directory; resolving one reads its metadata, so it is kept a while.
            if (!under(root, path))
                return [];
            let cached = placements.get(path);
            if (!cached || Date.now() - cached.at > 600_000)
                placements.set(path, cached = { at: Date.now(), value: access.resolve(path) });
            const placement = await cached.value.catch(() => ({ hostIds: [], cwd: undefined }));
            const cwd = placement.cwd;
            return cwd ? placement.hostIds.filter(id => store.hosts().some(host => host.id === id && sharesSessions(host))).map(hostId => ({ hostId, remotePath: cwd })) : [];
        },
        shared: hostId => machines.sharedWorkspaceList(hostId),
        publish: (hostId, path, tags) => machines.setWorkspaceTags(hostId, path, tags),
        warn: message => { const logger = ctx.get('logger'); if (logger?.warn)
            logger.warn(message);
        else
            console.warn(`[dsh-remote-agents] ${message}`); },
    });
    // DSH lists its workspaces only as a stream; follow it, and start over when it ends.
    const controller = new AbortController();
    void (async () => {
        while (!controller.signal.aborted) {
            const workspaces = ctx.get('workspaceController');
            try {
                if (workspaces)
                    for await (const frame of workspaces.follow(controller.signal)) {
                        const keep = (item) => { const w = item; if (typeof w?.workspaceId === 'string' && typeof w.path === 'string')
                            listed.set(w.workspaceId, { workspaceId: w.workspaceId, path: w.path }); };
                        if (frame.type === 'baseline' || frame.type === 'replace') {
                            listed.clear();
                            for (const item of frame.value?.items ?? [])
                                keep(item);
                        }
                        else if (frame.type === 'upsert')
                            keep(frame.workspace);
                        else if (frame.type === 'remove' && frame.workspaceId)
                            listed.delete(frame.workspaceId);
                        else
                            continue;
                        sync.trigger();
                    }
            }
            catch { /* followed again below */ }
            await new Promise(resolve => { const timer = setTimeout(resolve, 10_000); timer.unref?.(); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true }); });
        }
    })();
    sync.start();
    ctx.effect(() => () => { controller.abort(); sync.close(); });
}
