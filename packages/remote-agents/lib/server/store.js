import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
        this.state = { version: 1, hosts: value.hosts, tasks: value.tasks, ...(value.mainChatProjects ? { mainChatProjects: value.mainChatProjects } : {}),
            ...(value.relayCleanups ? { relayCleanups: value.relayCleanups } : {}), ...(value.chatEfforts ? { chatEfforts: value.chatEfforts } : {}),
            ...(value.chatFast ? { chatFast: value.chatFast } : {}), ...(value.sharing ? { sharing: value.sharing } : {}) };
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
        });
        this.writes = write.catch(() => { });
        return write;
    }
    async flush() { await this.writes; }
    /** Finish queued writes, then refuse new ones: a closed instance must not overwrite its successor's state. */
    async close() { this.closed = true; await this.writes; }
}
