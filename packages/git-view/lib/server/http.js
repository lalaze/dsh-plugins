import { CLIENT_HEADER, TEXT_LIMIT } from './domain.js';
import { GitError } from './runner.js';
// A UTF-8 byte may become six JSON bytes; leave room for the rest of a save request as well.
const BODY_LIMIT = TEXT_LIMIT * 6 + 64 * 1024;
const text = (value, label) => {
    if (typeof value !== 'string' || !value || value.length > 4096)
        throw new GitError(`Invalid ${label}`);
    return value;
};
/** `POST /api/git-view` with `{ action, sessionId, ... }`. Every action works on the conversation's own workspace. */
export function createHandler(git, log) {
    return async (request) => {
        const headers = { 'Cache-Control': 'no-store' };
        try {
            if (request.headers.get(CLIENT_HEADER) !== '1')
                throw new GitError('Use the Git view to submit requests', 403);
            if (request.method !== 'POST')
                return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
            if (!request.headers.get('content-type')?.startsWith('application/json'))
                throw new GitError('Requests must be JSON', 415);
            if (Number(request.headers.get('content-length')) > BODY_LIMIT)
                throw new GitError('The file exceeds the 4 MB editor limit', 413);
            const body = await request.text();
            if (Buffer.byteLength(body) > BODY_LIMIT)
                throw new GitError('The file exceeds the 4 MB editor limit', 413);
            let input;
            try {
                input = JSON.parse(body);
            }
            catch {
                throw new GitError('Requests must be JSON');
            }
            if (!input || typeof input !== 'object')
                throw new GitError('Requests must be JSON');
            const signal = request.signal, id = input.requestId;
            if (input.action === 'cancel') {
                await git.cancel(id);
                return Response.json({ ok: true }, { headers });
            }
            const s = text(input.sessionId, 'session ID');
            const result = await (async () => {
                switch (input.action) {
                    case 'summary': return git.summary(s, signal);
                    case 'branches': return git.branches(s, signal);
                    case 'overview': return git.overview(s, signal);
                    case 'status': return git.status(s, signal);
                    case 'diff': return git.diff(s, input.path, signal, input.staged === true);
                    case 'compare': return git.compare(s, input.path, signal, input.expectedCwd);
                    case 'save': return git.save(s, input.path, input.content, input.revision, signal, input.expectedCwd);
                    case 'saveResolve': return git.saveResolve(s, input.path, input.content, input.revision, id, signal, input.expectedCwd);
                    case 'switch': return git.switchBranch(s, input.branch, input.remote === true, id, signal);
                    case 'pull': return git.pull(s, id, signal);
                    case 'fetch': return git.fetch(s, id, signal);
                    case 'push': return git.push(s, id, signal);
                    case 'sync': return git.sync(s, id, signal);
                    case 'rename': return git.rename(s, input.branch, input.to, id, signal);
                    case 'deleteBranch': return git.deleteBranch(s, input.branch, id, signal);
                    case 'deleteRemoteBranch': return git.deleteRemoteBranch(s, input.branch, id, signal);
                    case 'merge': return git.merge(s, input.branch, id, signal);
                    case 'commit': return git.commit(s, input.message, id, signal);
                    case 'stashPush': return git.stashPush(s, input.message, id, signal);
                    case 'stashPop': return git.stashPop(s, id, signal);
                    case 'stage': return git.stage(s, input.path, id, signal, input.expectedCwd);
                    case 'unstage': return git.unstage(s, input.path, id, signal, input.from);
                    case 'discard': return git.discard(s, input.path, input.untracked === true, id, signal);
                    case 'cherryPick': return git.cherryPick(s, input.sha, id, signal);
                    case 'revert': return git.revert(s, input.sha, id, signal);
                    case 'credentialTarget': return git.credentialTarget(s, signal);
                    case 'saveCredential':
                        await git.saveCredential(s, input.host, input.username, input.password, signal);
                        return { ok: true };
                    default: throw new GitError('Unknown Git action');
                }
            })();
            return Response.json(result, { headers });
        }
        catch (error) {
            if (error instanceof GitError)
                return Response.json({ error: error.message, ...error.detail }, { status: error.status, headers });
            log?.(`Git view request failed: ${String(error)}`);
            return Response.json({ error: 'The Git request failed' }, { status: 500, headers });
        }
    };
}
