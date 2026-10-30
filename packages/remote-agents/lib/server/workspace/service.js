import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { RemoteError, field, record } from '../core/domain.js';
import { under } from './access.js';
import { FILE_LIMIT, TEXT_LIMIT } from './domain.js';
export const hash = (data) => createHash('sha256').update(data).digest('hex');
const ignore = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.dsh-remote-agents', '.dsh-remote-meta.json']);
/** A path exactly as given: names may begin or end with spaces, so trimming would address a different file. */
export function workspacePath(value, label) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r]/.test(value))
        throw new RemoteError(`Invalid ${label}`);
    return value;
}
export function fileOperation(raw) {
    const v = record(raw), op = field(v.op, 'workspace operation', 40), path = v.path === '' ? '' : workspacePath(v.path ?? '.', 'workspace path');
    if (op === 'list' || op === 'read' || op === 'stat' || op === 'mkdir' || op === 'manifest')
        return { op, path };
    if (op === 'webStart' || op === 'webStop') {
        if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1024 || v.port > 65535)
            throw new RemoteError('Enter a port between 1024 and 65535');
        if (op === 'webStop')
            return { op, path, port: v.port };
        // Passed to dsh as --trusted-host, so it must not read as an option.
        if (typeof v.host !== 'string' || v.host.length > 253 || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(v.host))
            throw new RemoteError('Invalid remote DSH access address');
        return { op, path, port: v.port, host: v.host };
    }
    if (op === 'write') {
        if (typeof v.content !== 'string' || Buffer.byteLength(v.content) > TEXT_LIMIT)
            throw new RemoteError('File exceeds the 256 KB editor limit', 413);
        return { op, path, content: v.content, revision: revision(v.revision) };
    }
    if (op === 'remove' || op === 'move') {
        const rev = revision(v.revision);
        if (!rev)
            throw new RemoteError('A file revision is required');
        return op === 'remove' ? { op, path, revision: rev } : { op, path, revision: rev, destination: workspacePath(v.destination, 'destination') };
    }
    if (op === 'search')
        return { op, path, query: field(v.query, 'search string', 200) };
    if (op === 'command')
        return { op, path, command: field(v.command, 'remote command', 32000), timeoutMs: 30000 };
    throw new RemoteError('Unknown workspace operation');
}
export function revision(value) {
    if (value === null)
        return null;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new RemoteError('A file revision is required');
    return value;
}
/** All entry points derive host and cwd from the DSH session; callers can only assert an expected target. */
export class WorkspaceService {
    machines;
    placement;
    localCwd;
    syncing = new Set();
    /** Only this session's active request can cancel its pinned target, even after the session changes workspace. */
    gitJobs = new Map();
    constructor(machines, placement, localCwd) {
        this.machines = machines;
        this.placement = placement;
        this.localCwd = localCwd;
    }
    async target(sessionId, signal = new AbortController().signal, expected) {
        const value = await this.placement(sessionId, signal);
        const host = this.machines.hosts().find(h => value.hostIds.includes(h.id) && (!expected || h.id === expected.hostId));
        if (!host || !value.cwd)
            throw new RemoteError('Select a verified remote workspace first.', 409);
        if (expected && expected.cwd !== value.cwd)
            throw new RemoteError('The workspace changed during verification. Select the model again.', 409);
        return { hostId: host.id, label: host.label, cwd: value.cwd };
    }
    async operate(sessionId, raw, signal, expected) {
        const target = await this.target(sessionId, signal, expected), operation = fileOperation(raw);
        return this.machines.withWorkspace(target.hostId, async () => { await this.target(sessionId, signal, target); }, files => files.operate(target.cwd, operation, signal));
    }
    async download(sessionId, path, rev, signal, expected) {
        revision(rev);
        const target = await this.target(sessionId, signal, expected);
        return this.machines.withWorkspace(target.hostId, async () => { await this.target(sessionId, signal, target); }, files => files.download(target.cwd, path, rev, signal));
    }
    async upload(sessionId, path, rev, size, input, signal, expected) {
        revision(rev);
        const target = await this.target(sessionId, signal, expected);
        return this.machines.withWorkspace(target.hostId, async () => { await this.target(sessionId, signal, target); }, files => files.upload(target.cwd, path, rev, size, input, signal));
    }
    /** Git commands in the conversation's verified remote directory, for other plugins; never offered to models. */
    async git(sessionId, batch, signal, expected) {
        const key = JSON.stringify([sessionId, batch.id]);
        if (this.gitJobs.has(key))
            throw new RemoteError('This Git request is already running', 409);
        const job = { cancelled: false, started: false };
        // Register before target/connection discovery so an early cancellation cannot be lost.
        this.gitJobs.set(key, job);
        const check = () => { signal.throwIfAborted(); if (job.cancelled)
            throw new RemoteError('The Git operation was cancelled', 409); };
        try {
            const target = await this.target(sessionId, signal, expected);
            job.target = target;
            check();
            return await this.machines.withWorkspace(target.hostId, async () => { await this.target(sessionId, signal, target); check(); }, files => {
                check();
                job.started = true;
                return files.git(target.cwd, batch, signal);
            });
        }
        finally {
            if (this.gitJobs.get(key) === job)
                this.gitJobs.delete(key);
        }
    }
    async cancelGit(sessionId, id, signal, expected) {
        const key = JSON.stringify([sessionId, id]), job = this.gitJobs.get(key);
        if (!job)
            return;
        const target = job.target;
        if (target && expected && (target.hostId !== expected.hostId || target.cwd !== expected.cwd))
            throw new RemoteError('The workspace changed during verification. Select the model again.', 409);
        job.cancelled = true;
        if (!target || !job.started)
            return;
        // withWorkspace still verifies the SSH machine identity, but the conversation may now point elsewhere.
        await this.machines.withWorkspace(target.hostId, async () => { signal.throwIfAborted(); }, async (files) => {
            if (this.gitJobs.get(key) === job)
                await files.cancelGit(target.cwd, id, signal);
        });
    }
    async sync(sessionId, direction, dryRun, signal, expected, planId) {
        const target = await this.target(sessionId, signal, expected), local = await this.localCwd(sessionId);
        if (!local)
            throw new RemoteError('The local workspace anchor is unavailable');
        const root = await realpath(local), key = hash(JSON.stringify([root, target.hostId, target.cwd]));
        if (this.syncing.has(key))
            throw new RemoteError('A workspace sync is already running', 409);
        this.syncing.add(key);
        try {
            return await this.machines.withWorkspace(target.hostId, async () => { await this.target(sessionId, signal, target); }, async (files) => {
                const snapshot = join(this.machines.store.directory, 'workspace-sync', `${key}.json`);
                let base = Object.create(null);
                try {
                    base = record(JSON.parse(await readFile(snapshot, 'utf8')));
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                const remote = await files.operate(target.cwd, { op: 'manifest', path: '.' }, signal);
                const current = Object.create(null), skipped = [...remote.skipped];
                let count = 0, size = 0;
                const localPath = async (name, missing = false) => {
                    const p = resolve(root, name);
                    if (!under(root, p) || p === root || name.split(/[\\/]/).some(n => ignore.has(n) || n.startsWith('.dsh-ra-upload-')))
                        throw new RemoteError('Invalid sync path');
                    if (!under(root, await realpath(dirname(p))))
                        throw new RemoteError('Sync path escapes the workspace');
                    try {
                        if ((await lstat(p)).isSymbolicLink())
                            throw new RemoteError('Sync does not follow symbolic links');
                    }
                    catch (error) {
                        if (!missing || error.code !== 'ENOENT')
                            throw error;
                    }
                    return p;
                };
                const walk = async (dir) => {
                    if (!under(root, await realpath(dir)))
                        throw new RemoteError('Sync path escapes the workspace');
                    for (const name of await readdir(dir)) {
                        if (++count > 20000)
                            throw new RemoteError('Workspace contains too many files for one operation');
                        if (ignore.has(name) || name.startsWith('.dsh-ra-upload-'))
                            continue;
                        const p = join(dir, name), rel = relative(root, p).split(sep).join('/'), stat = await lstat(p);
                        if (stat.isSymbolicLink()) {
                            skipped.push(rel);
                            continue;
                        }
                        if (stat.isDirectory()) {
                            await walk(p);
                            continue;
                        }
                        if (!stat.isFile() || stat.size > FILE_LIMIT) {
                            skipped.push(rel);
                            continue;
                        }
                        size += stat.size;
                        if (size > 512 * 1024 * 1024)
                            throw new RemoteError('Workspace scan exceeds 512 MB');
                        current[rel] = { hash: hash(await readFile(await localPath(rel))), size: stat.size };
                    }
                };
                await walk(root);
                const result = { direction, dryRun, changes: [], conflicts: [], skipped };
                const source = direction === 'pull' ? remote.files : current, destination = direction === 'pull' ? current : remote.files;
                const next = Object.assign(Object.create(null), base);
                // A path skipped on either side (a symbolic link, special or oversized file) is missing from that side's
                // manifest, not deleted: leave it, everything below it and its baseline untouched.
                const skippedPaths = new Set(skipped);
                const excluded = (name) => name.split('/').some((_, i, parts) => skippedPaths.has(parts.slice(0, i + 1).join('/')));
                for (const name of new Set([...Object.keys(base), ...Object.keys(source), ...Object.keys(destination)])) {
                    if (excluded(name))
                        continue;
                    const a = source[name]?.hash ?? null, b = destination[name]?.hash ?? null, previous = base[name] ?? null;
                    if (a === b) {
                        if (a)
                            next[name] = a;
                        else
                            delete next[name];
                        continue;
                    }
                    if (a === previous)
                        continue; // Changes on the destination are preserved for the other direction.
                    if (b !== previous) {
                        result.conflicts.push(name);
                        continue;
                    }
                    result.changes.push({ path: name, action: a ? 'copy' : 'delete', source: a, destination: b });
                }
                result.planId = hash(JSON.stringify([direction, result.changes, result.conflicts, result.skipped]));
                if (!dryRun && planId && planId !== result.planId)
                    throw new RemoteError('Files changed during sync. Preview again.', 409);
                for (const change of dryRun ? [] : result.changes) {
                    signal.throwIfAborted();
                    await this.target(sessionId, signal, target);
                    const name = change.path, expectedHash = change.source;
                    if (direction === 'pull') {
                        // Create parents one level at a time, verifying that no symlink redirects the write.
                        let parent = root;
                        for (const part of name.split('/').slice(0, -1)) {
                            parent = join(parent, part);
                            if (!under(root, parent) || ignore.has(part))
                                throw new RemoteError('Invalid sync path');
                            await mkdir(parent).catch(e => { if (e.code !== 'EEXIST')
                                throw e; });
                            if ((await lstat(parent)).isSymbolicLink() || !under(root, await realpath(parent)))
                                throw new RemoteError('Sync path escapes the workspace');
                        }
                        const p = await localPath(name, true);
                        const data = expectedHash ? await files.download(target.cwd, name, expectedHash, signal) : undefined;
                        let actual = null;
                        try {
                            actual = hash(await readFile(p));
                        }
                        catch (error) {
                            if (error.code !== 'ENOENT')
                                throw error;
                        }
                        if (actual !== change.destination || data && hash(data) !== expectedHash)
                            throw new RemoteError('Files changed during sync. Preview again.', 409);
                        if (!data)
                            await rm(p);
                        else {
                            const tmp = join(dirname(p), `.dsh-ra-upload-${randomUUID()}`);
                            // A replaced file keeps its permissions, such as a script's execute bit; chmod is exact regardless of umask.
                            const existing = actual === null ? undefined : (await lstat(p)).mode & 0o777;
                            try {
                                await writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
                                if (existing !== undefined)
                                    await chmod(tmp, existing);
                                await rename(tmp, p);
                            }
                            finally {
                                await rm(tmp, { force: true });
                            }
                        }
                    }
                    else {
                        if (!expectedHash)
                            await files.operate(target.cwd, { op: 'remove', path: name, revision: change.destination }, signal);
                        else {
                            const data = await readFile(await localPath(name));
                            if (hash(data) !== expectedHash)
                                throw new RemoteError('Files changed during sync. Preview again.', 409);
                            let parent = '';
                            for (const part of name.split('/').slice(0, -1)) {
                                parent = parent ? `${parent}/${part}` : part;
                                await files.operate(target.cwd, { op: 'mkdir', path: parent }, signal).catch(error => { if (!(error instanceof RemoteError && error.status === 409))
                                    throw error; });
                            }
                            await files.upload(target.cwd, name, change.destination, data.length, (async function* () { yield data; })(), signal);
                        }
                    }
                    if (expectedHash)
                        next[name] = expectedHash;
                    else
                        delete next[name];
                }
                if (!dryRun) {
                    await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 });
                    const tmp = `${snapshot}.${randomUUID()}.tmp`;
                    try {
                        await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
                        await rename(tmp, snapshot);
                    }
                    finally {
                        await rm(tmp, { force: true });
                    }
                }
                return result;
            });
        }
        finally {
            this.syncing.delete(key);
        }
    }
}
