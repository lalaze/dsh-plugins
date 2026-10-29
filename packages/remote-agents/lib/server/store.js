import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { identifier, record, remotePath, field, taskInput, providerSelection, RemoteError } from './domain.js';
export class Store {
    path;
    state = { version: 1, hosts: [], tasks: [] };
    writes = Promise.resolve();
    /** The file content this instance last read or wrote; undefined when the file did not exist. */
    saved;
    closed = false;
    /** Listeners for the tokens each finished CLI turn used; the plugin forwards them to usage statistics. */
    usageListeners = new Set();
    /** Called after every saved change; shared hosts publish the task records that changed. */
    changeListeners = new Set();
    constructor(path) {
        this.path = path;
    }
    get directory() { return dirname(this.path); }
    async open() {
        let text;
        try {
            text = await readFile(this.path, 'utf8');
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return;
            throw e;
        }
        this.saved = text;
        // A damaged registry must never be replaced with an empty one, losing agent identities.
        const value = record(JSON.parse(text));
        if (value.version !== 1 || !Array.isArray(value.hosts) || !Array.isArray(value.tasks))
            throw new Error('Invalid remote agent registry');
        for (const raw of value.hosts) {
            const host = record(raw);
            identifier(host.id);
            if (typeof host.connection !== 'string' || typeof host.label !== 'string' || (host.password !== undefined && typeof host.password !== 'string') || (host.serverId !== undefined && typeof host.serverId !== 'string'))
                throw new Error('Invalid saved remote host');
            if (host.modelError !== undefined && typeof host.modelError !== 'string')
                throw new Error('Invalid saved host discovery error');
            if (host.enabledProviders !== undefined)
                host.enabledProviders = providerSelection(host.enabledProviders);
            if (host.share !== undefined && typeof host.share !== 'boolean')
                throw new Error('Invalid saved session sharing setting');
            if (host.catalog !== undefined) {
                const catalog = record(host.catalog);
                remotePath(catalog.cwd);
                if (typeof catalog.checkedAt !== 'string' || !Array.isArray(catalog.providers) || !catalog.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes)))
                    throw new Error('Invalid saved host model catalog');
            }
        }
        for (const raw of value.tasks) {
            taskInput(raw);
            const task = record(raw);
            if (typeof task.serverId !== 'string' || typeof task.title !== 'string' || typeof task.createdAt !== 'string' || !['creating', 'ready', 'uncertain'].includes(String(task.state)))
                throw new Error('Invalid saved remote agent');
            if (task.relay !== undefined)
                identifier(record(task.relay).id);
            if (task.shared !== undefined && !Number.isSafeInteger(record(task.shared).rev))
                throw new Error('Invalid saved shared session');
        }
        if (value.relayCleanups !== undefined) {
            if (!Array.isArray(value.relayCleanups))
                throw new Error('Invalid saved relay cleanups');
            for (const raw of value.relayCleanups) {
                const cleanup = record(raw);
                identifier(cleanup.hostId);
                identifier(cleanup.relayId);
            }
        }
        if (value.mainChatProjects !== undefined) {
            if (!Array.isArray(value.mainChatProjects))
                throw new Error('Invalid saved chat projects');
            for (const raw of value.mainChatProjects) {
                const project = record(raw);
                identifier(project.id);
                identifier(project.hostId);
                field(project.label, 'project name', 100);
                remotePath(project.cwd);
                if (!Array.isArray(project.providers) || !project.providers.every(p => p && typeof p.id === 'string' && Array.isArray(p.models) && Array.isArray(p.modes)))
                    throw new Error('Invalid saved chat project catalog');
            }
        }
        if (value.chatEfforts !== undefined && !Object.values(record(value.chatEfforts)).every(effort => typeof effort === 'string'))
            throw new Error('Invalid saved reasoning efforts');
        if (value.chatFast !== undefined && (!Array.isArray(value.chatFast) || !value.chatFast.every(id => typeof id === 'string')))
            throw new Error('Invalid saved Fast conversations');
        if (value.sharing !== undefined) {
            const sharing = record(value.sharing);
            for (const table of [sharing.mcp, sharing.skills])
                if (table !== undefined && !Object.values(record(table)).every(shared => typeof shared === 'boolean'))
                    throw new Error('Invalid saved sharing settings');
            if (sharing.secret !== undefined && (typeof sharing.secret !== 'string' || !/^[a-f0-9]{64}$/.test(sharing.secret)))
                throw new Error('Invalid saved sharing secret');
        }
        if (value.instance !== undefined) {
            const instance = record(value.instance);
            identifier(instance.id);
            field(instance.label, 'instance name', 100);
        }
        if (value.sharedDeletions !== undefined) {
            if (!Array.isArray(value.sharedDeletions))
                throw new Error('Invalid saved shared deletions');
            for (const raw of value.sharedDeletions) {
                const deletion = record(raw);
                identifier(deletion.hostId);
                identifier(deletion.id);
            }
        }
        if (value.seenWorkspaces !== undefined && !Object.values(record(value.seenWorkspaces)).every(paths => Array.isArray(paths) && paths.every(path => typeof path === 'string')))
            throw new Error('Invalid saved shared workspaces');
        this.state = { version: 1, hosts: value.hosts, tasks: value.tasks, ...(value.mainChatProjects ? { mainChatProjects: value.mainChatProjects } : {}),
            ...(value.relayCleanups ? { relayCleanups: value.relayCleanups } : {}), ...(value.chatEfforts ? { chatEfforts: value.chatEfforts } : {}),
            ...(value.chatFast ? { chatFast: value.chatFast } : {}), ...(value.sharing ? { sharing: value.sharing } : {}),
            ...(value.instance ? { instance: value.instance } : {}), ...(value.seenWorkspaces ? { seenWorkspaces: value.seenWorkspaces } : {}),
            ...(value.sharedDeletions ? { sharedDeletions: value.sharedDeletions } : {}) };
    }
    snapshot() { return structuredClone(this.state); }
    /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
    hosts() { return structuredClone(this.state.hosts); }
    chatProjects() { return structuredClone(this.state.mainChatProjects ?? []); }
    /** A copy of the sharing settings; read for every shared tool listing and call. */
    sharing() { return structuredClone(this.state.sharing ?? {}); }
    /** The reasoning effort a native chat model route last used, if any. */
    /** Whether a DSH conversation's Codex turns use the Fast speed. */
    chatFast(sessionId) { return this.state.chatFast?.includes(sessionId) ?? false; }
    chatEffort(route) { return Object.hasOwn(this.state.chatEfforts ?? {}, route) ? this.state.chatEfforts[route] : undefined; }
    /** This DSH's identity for shared hosts, created on first use. */
    async instance() {
        if (!this.state.instance)
            await this.update(state => { state.instance ??= { id: `dsh-${randomUUID()}`, label: (hostname() || 'DSH').slice(0, 100) }; });
        return structuredClone(this.state.instance);
    }
    seenWorkspaces(hostId) { return [...(this.state.seenWorkspaces?.[hostId] ?? [])]; }
    sharedDeletions(hostId) { return (this.state.sharedDeletions ?? []).filter(d => d.hostId === hostId).map(d => d.id); }
    relayCleanups(hostId) { return structuredClone((this.state.relayCleanups ?? []).filter(c => c.hostId === hostId)); }
    /** A copy of one saved agent record, without cloning the whole registry. */
    task(predicate) { const found = this.state.tasks.find(predicate); return found && structuredClone(found); }
    tasks(predicate) { return structuredClone(this.state.tasks.filter(predicate)); }
    /** Serialize read/modify/atomic-rename, including concurrent HTTP requests. */
    async update(change) {
        if (this.closed)
            return Promise.reject(new RemoteError('Remote agent state is closed', 503));
        const write = this.writes.then(async () => {
            const next = this.snapshot();
            change(next);
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            // Never replace state another DSH instance wrote, for example after a plugin reload, with a stale snapshot.
            const current = await readFile(this.path, 'utf8').catch(e => { if (e.code === 'ENOENT')
                return undefined; throw e; });
            if (current !== this.saved)
                throw new RemoteError('Remote agent state was changed by another DSH instance. Reload the plugin.', 409);
            const text = `${JSON.stringify(next, null, 2)}\n`, temporary = `${this.path}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
                await rename(temporary, this.path);
            }
            finally {
                await unlink(temporary).catch(() => { });
            }
            this.state = next;
            this.saved = text;
            for (const listener of this.changeListeners) {
                try {
                    listener();
                }
                catch { /* A listener must not fail the saved change. */ }
            }
        });
        this.writes = write.catch(() => { });
        return write;
    }
    async flush() { await this.writes; }
    /** Finish queued writes, then refuse new ones: a closed instance must not overwrite its successor's state. */
    async close() { this.closed = true; await this.writes; }
}
