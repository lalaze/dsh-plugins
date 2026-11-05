import { field, identifier, RemoteError } from '../core/domain.js';
import { FILE_LIMIT } from './domain.js';
import { revision, workspacePath } from './service.js';
const JOB_ACTIONS = ['cancel', 'retry', 'skip', 'discard'];
/** Worktree workspaces: a project's DSH workspace path, a worktree's path on its machine, and operation IDs. */
export async function worktreeAction(worktrees, action, input, signal) {
    const path = () => workspacePath(input.path, 'workspace path'), job = () => identifier(input.jobId);
    const name = (value, label) => value === undefined || value === '' ? undefined : field(value, label, 250);
    switch (action) {
        case 'worktreeProjects': return worktrees.projects(signal);
        case 'worktreeInspect': return worktrees.inspect(path(), signal);
        case 'createWorktree': {
            if (input.mode !== 'new' && input.mode !== 'existing')
                throw new RemoteError('Invalid worktree mode');
            return worktrees.create({ path: path(), mode: input.mode, base: name(input.base, 'branch'), branch: name(input.branch, 'branch') });
        }
        case 'worktreeJob': return worktrees.job(job());
        case 'worktreeJobAction': {
            if (!JOB_ACTIONS.includes(input.jobAction))
                throw new RemoteError('Invalid worktree action');
            return worktrees.act(job(), input.jobAction);
        }
        case 'worktreeArchiveCheck': return worktrees.archiveCheck(path(), workspacePath(input.worktree, 'worktree'), signal);
        case 'archiveWorktree': return worktrees.archive({ path: path(), worktree: workspacePath(input.worktree, 'worktree'), deleteBranch: input.deleteBranch === true });
    }
    throw new RemoteError('Unknown workspace action');
}
export function expectedTarget(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== 'object')
        throw new RemoteError('Invalid workspace target');
    const v = value;
    return { hostId: identifier(v.hostId), cwd: workspacePath(v.cwd, 'remote workspace'), label: '' };
}
export async function workspaceAction(features, action, input, signal) {
    if (action === 'tuiSessions')
        return { sessions: features.tui?.list() ?? [], codex: features.tui?.codex() ?? [] };
    const sessionId = field(input.sessionId, 'session ID', 256), expected = expectedTarget(input.target);
    if (action === 'tuiStart') {
        if (!features.tui)
            throw new RemoteError('The TUI is unavailable', 501);
        await features.tui.start(sessionId, { cli: input.cli, model: input.model, effort: input.effort }, signal);
        return { sessionId };
    }
    if (action === 'tuiTitle')
        return { title: await features.tui?.syncTitle(sessionId, input.current, signal), waiting: features.captain?.waiting(sessionId) ?? 0 };
    if (action === 'tuiPrepare') {
        await features.tui?.prepare(sessionId, signal);
        return { ok: true };
    }
    if (action === 'tuiTeam') {
        if (!features.captain)
            throw new RemoteError('The TUI is unavailable', 501);
        return { text: await features.captain.team(sessionId, typeof input.line === 'string' ? input.line : '', signal) };
    }
    if (action === 'workspaceTarget') {
        const target = await features.files.target(sessionId, signal, expected), shell = features.terminal?.shell;
        return shell ? { ...target, terminalShell: shell } : target;
    }
    if (action === 'workspaceFiles')
        return features.files.operate(sessionId, input.operation, signal, expected);
    if (action === 'workspaceSync') {
        if (input.direction !== 'pull' && input.direction !== 'push')
            throw new RemoteError('Invalid sync direction');
        const plan = input.apply === true ? field(input.planId, 'sync preview', 64) : undefined;
        return features.files.sync(sessionId, input.direction, input.apply !== true, signal, expected, plan);
    }
    const target = await features.files.target(sessionId, signal, expected);
    if (action === 'workspaceTunnels')
        return features.tunnels.list(target.hostId);
    if (action === 'addWorkspaceTunnel') {
        const tunnel = input.tunnel && typeof input.tunnel === 'object' ? input.tunnel : {};
        return features.tunnels.add({ ...tunnel, hostId: target.hostId });
    }
    const id = identifier(input.id);
    if (action === 'startWorkspaceTunnel') {
        await features.files.machines.connect(target.hostId);
        await features.files.target(sessionId, signal, target);
        return features.tunnels.start(id, target.hostId);
    }
    if (action === 'stopWorkspaceTunnel') {
        features.tunnels.stop(id, target.hostId);
        return { ok: true };
    }
    if (action === 'removeWorkspaceTunnel') {
        await features.tunnels.remove(id, target.hostId);
        return { ok: true };
    }
    throw new RemoteError('Unknown workspace action');
}
const requireClient = (request) => { if (request.headers.get('X-DSH-Remote-Agents') !== '1')
    throw new RemoteError('Use the remote agents client to submit requests', 403); };
const transferFailure = (error) => Response.json({ error: error instanceof Error ? error.message : 'File transfer failed' }, { status: error instanceof RemoteError ? error.status : 502 });
/** The size an upload declares. */
function transferSize(request) {
    const size = Number(request.headers.get('X-File-Size'));
    if (!request.headers.has('X-File-Size') || !Number.isSafeInteger(size) || size < 0 || size > FILE_LIMIT)
        throw new RemoteError('File exceeds the 50 MB transfer limit', 413);
    return size;
}
/** An upload's body as it arrives, held to exactly the size it declared. */
async function* transferBody(request, size) {
    const reader = request.body?.getReader();
    let bytes = 0;
    if (reader) {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                bytes += value.length;
                if (bytes > size)
                    throw new RemoteError('Upload byte count mismatch', 413);
                yield value;
            }
        }
        finally {
            await reader.cancel().catch(() => { });
            reader.releaseLock();
        }
    }
    if (bytes !== size)
        throw new RemoteError('Upload byte count mismatch');
}
export function workspaceTransferHandler(files) {
    return async (request) => {
        try {
            requireClient(request);
            const q = new URL(request.url).searchParams;
            const sessionId = field(q.get('sessionId'), 'session ID', 256), path = workspacePath(q.get('path'), 'file path');
            const target = expectedTarget({ hostId: q.get('hostId'), cwd: q.get('cwd') });
            if (request.method === 'GET') {
                const rev = revision(q.get('revision'));
                if (!rev)
                    throw new RemoteError('A file revision is required');
                const data = await files.download(sessionId, path, rev, request.signal, target);
                return new Response(new Uint8Array(data), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': String(data.length), 'X-Content-Type-Options': 'nosniff' } });
            }
            if (request.method !== 'POST')
                return new Response(null, { status: 405 });
            const size = transferSize(request);
            const rev = revision(request.headers.get('X-File-Revision') === 'new' ? null : request.headers.get('X-File-Revision'));
            return Response.json(await files.upload(sessionId, path, rev, size, transferBody(request, size), request.signal, target), { headers: { 'Cache-Control': 'no-store' } });
        }
        catch (error) {
            return transferFailure(error);
        }
    };
}
/** A file dropped or pasted into a TUI conversation, which comes back as its absolute path on the conversation's machine. */
export function tuiFilesHandler(files) {
    return async (request) => {
        try {
            requireClient(request);
            const q = new URL(request.url).searchParams, sessionId = field(q.get('sessionId'), 'session ID', 256), size = transferSize(request);
            return Response.json({ path: await files.upload(sessionId, q.get('name'), transferBody(request, size), request.signal) }, { headers: { 'Cache-Control': 'no-store' } });
        }
        catch (error) {
            return transferFailure(error);
        }
    };
}
