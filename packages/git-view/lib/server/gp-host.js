import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { CLIENT_HEADER } from './domain.js';
import { normalizeConfig, resolveBrowseRoot, snapshotForSession } from './gp/host/core.js';
import { createFsDeps } from './gp/host/fs-deps.js';
import { createGitRunner } from './gp/host/git.js';
import { canOpenWithSystem, openWithSystem } from './gp/host/open-file.js';
import { runAction } from './gp/host/actions.js';
import { runQuery } from './gp/host/queries.js';
import { runSuggest } from './gp/host/suggest.js';
import { sessionModelReader } from './gp/host/session-model.js';
import { GIT_ENV } from './runner.js';
const fail = (code, message) => ({ ok: false, error: { code, ...message ? { message } : {} } });
/** Over SSH a command takes a round trip, so it gets more time than the panel's local default. */
const REMOTE_MIN_TIMEOUT = 30_000;
/** Network commands may take longer than reads anywhere. */
const NETWORK = new Set(['fetch', 'pull', 'push']);
/** A remote absolute path inside the workspace, relative to it; anything else is not reachable. */
function inside(root, path) {
    const relative = posix.relative(root, posix.resolve(root, path));
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative))
        throw Object.assign(new Error('Path is outside the remote workspace'), { code: 'ENOENT' });
    return relative;
}
const missing = () => Object.assign(new Error('No such file or directory'), { code: 'ENOENT' });
/** Git on the SSH host: every command runs in its own folder through `git -C`, in one verified batch. */
function remoteRunner(service, sessionId, target, config) {
    return {
        async run(argv, opts) {
            let args = argv.slice(1), lines = false;
            // Remote batches have no standard input; `check-ignore --stdin -z` takes the same paths as arguments, where Git
            // prints one unquoted path per line instead of NUL-terminated ones.
            if (opts.stdinData !== undefined) {
                if (args[0] !== 'check-ignore')
                    throw new Error('Remote Git commands take no input');
                const paths = opts.stdinData.split('\0').filter(Boolean);
                args = ['-c', 'core.quotePath=false', ...args.filter(arg => arg !== '--stdin' && arg !== '-z'), '--', ...paths];
                lines = true;
            }
            const timeoutMs = Math.max(REMOTE_MIN_TIMEOUT, config.timeoutMs) * (NETWORK.has(args[lines ? 2 : 0]) ? 3 : 1);
            try {
                const [run] = await service.git(sessionId, { id: randomUUID(), commands: [{ argv: ['-C', opts.cwd, ...args], timeoutMs }], maxBytes: config.maxBytes }, opts.signal, target);
                const cancelled = opts.signal?.aborted === true;
                const stdout = lines ? run.stdout.split('\n').filter(Boolean).map(path => `${path}\0`).join('') : run.stdout;
                return { exitCode: run.exitCode, stdout, stderr: run.stderr, timedOut: run.timedOut, cancelled, stdoutLossy: run.truncated };
            }
            catch (error) {
                if (opts.signal?.aborted)
                    return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, stdoutLossy: false };
                throw error;
            }
        },
    };
}
/**
 * The remote workspace's files under its absolute paths. Links are not resolved; a folder's entries come from one
 * listing, kept for the request, so status times for many files cost one round trip per folder.
 */
function remoteFs(service, sessionId, target, runner, signal) {
    const root = target.cwd, listings = new Map();
    const list = (dir) => {
        const relative = inside(root, dir);
        let listing = listings.get(relative);
        if (!listing) {
            if (!service.list)
                throw Object.assign(new Error('Update Remote Agents to browse remote folders'), { code: 'ENOTSUP' });
            listing = service.list(sessionId, relative || '.', signal, target).then(({ entries }) => new Map(entries.map(entry => [entry.name, entry])));
            listings.set(relative, listing);
            listing.catch(() => listings.delete(relative));
        }
        return listing;
    };
    const entry = async (path) => {
        const relative = inside(root, path);
        if (!relative)
            return { kind: 'directory', size: 0, modified: '' };
        const found = (await list(posix.join(root, posix.dirname(relative)))).get(posix.basename(relative));
        if (!found)
            throw missing();
        return found;
    };
    return {
        realpath: async (path) => { inside(root, path); return posix.resolve(root, path); },
        stat: async (path) => {
            const found = await entry(path), modified = Date.parse(found.modified);
            return { mtimeMs: Number.isNaN(modified) ? 0 : modified, size: found.size, isDirectory: () => found.kind === 'directory' };
        },
        readFile: async (path) => {
            const relative = inside(root, path), { revision } = await service.stat(sessionId, relative, signal, target);
            return service.download(sessionId, relative, revision, signal, target);
        },
        symlinkTarget: async () => null,
        readdir: async (path) => [...(await list(path))].map(([name, found]) => ({ name, isDirectory: found.kind === 'directory' })),
        // Untracked files and folders go through Git, which removes whole folders; other files only when unchanged.
        remove: async (path) => {
            const relative = inside(root, path);
            if (!relative)
                throw new Error('Cannot remove the workspace root');
            if (!relative.split('/').includes('.git')) {
                const cleaned = await runner.run(['git', 'clean', '-f', '-f', '-d', '-q', '--', posix.basename(relative)], { cwd: posix.join(root, posix.dirname(relative)), ...signal ? { signal } : {} });
                if (cleaned.exitCode === 0)
                    return;
            }
            if (!service.remove)
                throw new Error('Update Remote Agents to remove remote files');
            const { revision } = await service.stat(sessionId, relative, signal, target);
            await service.remove(sessionId, relative, revision, signal, target);
        },
    };
}
export class PanelHost {
    options;
    localRoots = new Map();
    localMisses = new Map();
    remoteCaches = new Map();
    constructor(options) {
        this.options = options;
    }
    config() { return normalizeConfig(this.options.config); }
    /** What the panel's functions need for one conversation: local, or its verified remote workspace. */
    async deps(sessionId, signal) {
        const { options } = this, config = this.config(), get = options.get;
        const cwd = await options.cwdOf(sessionId);
        const common = {
            ...signal ? { signal } : {},
            getLlm: () => get('llm'),
            getAgentDefaultModel: () => get('agentDefaultModel'),
            getSessionModel: sessionModelReader(get),
        };
        if (cwd && options.isRemoteCwd(cwd)) {
            const service = options.remote();
            if (!service || service.gitWorkspaceVersion !== 1)
                throw new PanelError('git-unavailable', service ? 'Update Remote Agents to a version with Git workspace support' : 'Install Remote Agents to use Git in this remote workspace');
            const target = await service.target(sessionId, signal);
            if (cwd !== await options.cwdOf(sessionId))
                throw new PanelError('git-error', 'The workspace changed. Reopen the file before continuing.');
            const key = `${target.hostId}\0${target.cwd}`;
            let caches = this.remoteCaches.get(key);
            if (!caches)
                this.remoteCaches.set(key, caches = { roots: new Map(), misses: new Map() });
            const run = remoteRunner(service, sessionId, target, config);
            return { ...common, remote: true, run, fs: remoteFs(service, sessionId, target, run, signal), rootCache: caches.roots, rootNegCache: caches.misses,
                sessions: { liveCwd: () => target.cwd, persistedMeta: async () => ({ cwd: target.cwd }) } };
        }
        // Local Git sees git-view's environment and saved credentials, as its other requests do.
        const subprocess = { spawn: spec => options.subprocess.spawn({ ...spec, env: { ...GIT_ENV, ...spec.env } }) };
        const inner = createGitRunner(subprocess, config.timeoutMs, config.maxBytes);
        const run = {
            async run(argv, opts) {
                const [git, extra] = await Promise.all([options.git(), options.gitConfig()]);
                const timed = NETWORK.has(argv[1]) ? createGitRunner(subprocess, config.timeoutMs * 6, config.maxBytes) : inner;
                return timed.run([git, ...extra, ...argv.slice(1)], opts);
            },
        };
        return { ...common, remote: false, run, fs: createFsDeps(), rootCache: this.localRoots, rootNegCache: this.localMisses,
            sessions: { liveCwd: () => cwd, persistedMeta: async () => cwd ? { cwd } : undefined } };
    }
    async call(method, request, signal) {
        if (method === 'version')
            return { current: VERSION, updateAvailable: false, checkedRemote: false };
        if (!request || typeof request !== 'object')
            return fail('git-error', 'Invalid request');
        const sessionId = request.sessionId;
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096)
            return fail('cwd-unavailable', 'Invalid session ID');
        const config = this.config();
        let deps;
        try {
            deps = await this.deps(sessionId, signal);
        }
        catch (error) {
            return error instanceof PanelError ? fail(error.code, error.message) : fail('git-unavailable', error instanceof Error ? error.message : String(error));
        }
        switch (method) {
            case 'snapshot': {
                const r = request;
                return snapshotForSession(deps, config, sessionId, { fullChanges: r.fullChanges === true, ...typeof r.repo === 'string' ? { repo: r.repo } : {} });
            }
            case 'run': return runAction(deps, config, request);
            case 'query': return runQuery(deps, config, request);
            case 'suggest': return runSuggest(deps, config, request);
            case 'openFile': {
                if (deps.remote)
                    return fail('git-error', 'Files of a remote workspace cannot open in an application on this computer');
                if (!canOpenWithSystem(process.platform))
                    return fail('git-error', 'this host cannot open files in a desktop application');
                const { path, repo } = request;
                const browse = await resolveBrowseRoot(deps, sessionId, repo);
                if (!browse.ok)
                    return { ok: false, error: browse.error };
                return openWithSystem(deps, browse.root, path, async (argv) => {
                    try {
                        const handle = this.options.subprocess.spawn({ argv, cwd: process.cwd(), graceMs: 200,
                            stdio: { stdin: 'ignore', stdout: { collect: { maxBytes: 4096 } }, stderr: { collect: { maxBytes: 4096 } } } });
                        return (await handle.done).exitCode;
                    }
                    catch {
                        return null;
                    }
                });
            }
            default: return fail('git-error', 'Unknown Git action');
        }
    }
}
class PanelError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** Set from package.json by the server entry. */
export let VERSION = '0.0.0';
export const setVersion = (version) => { VERSION = version; };
/** `POST /api/git-view/gp` with `{ method, request }`; answers `{ ok: true, value }` as the panel's RPC envelope did. */
export function panelHandler(host, log) {
    return async (request) => {
        const headers = { 'Cache-Control': 'no-store' };
        if (request.headers.get(CLIENT_HEADER) !== '1')
            return Response.json({ ok: false, error: { code: 'git-error', message: 'Use the Git view to submit requests' } }, { status: 403, headers });
        let body;
        try {
            body = JSON.parse(await request.text());
        }
        catch {
            return Response.json({ ok: false, error: { code: 'git-error', message: 'Requests must be JSON' } }, { status: 400, headers });
        }
        try {
            const value = await host.call(body?.method, body?.request, request.signal);
            return Response.json({ ok: true, value }, { headers });
        }
        catch (error) {
            log?.(`Git panel request failed: ${String(error)}`);
            return Response.json({ ok: false, error: { code: 'git-unavailable', message: error instanceof Error ? error.message : String(error) } }, { headers });
        }
    };
}
