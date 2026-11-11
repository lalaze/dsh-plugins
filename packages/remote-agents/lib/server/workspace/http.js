import { field, identifier, RemoteError } from '../core/domain.js';
import { requireClient, transferBody, transferFailure, transferSize } from '../core/transfer.js';
import { revision, workspacePath } from './service.js';
export function expectedTarget(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== 'object')
        throw new RemoteError('Invalid workspace target');
    const v = value;
    return { hostId: identifier(v.hostId), cwd: workspacePath(v.cwd, 'remote workspace'), label: '' };
}
export async function workspaceAction(features, action, input, signal) {
    const sessionId = field(input.sessionId, 'session ID', 256), expected = expectedTarget(input.target);
    if (action === 'workspaceTarget')
        return features.files.target(sessionId, signal, expected);
    if (action === 'workspaceFiles')
        return features.files.operate(sessionId, input.operation, signal, expected);
    if (action === 'workspaceSync') {
        if (input.direction !== 'pull' && input.direction !== 'push')
            throw new RemoteError('Invalid sync direction');
        const plan = input.apply === true ? field(input.planId, 'sync preview', 64) : undefined;
        return features.files.sync(sessionId, input.direction, input.apply !== true, signal, expected, plan);
    }
    throw new RemoteError('Unknown workspace action');
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
