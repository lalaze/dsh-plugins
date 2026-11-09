import { randomUUID } from 'node:crypto';
import { connectionInput } from './backend.js';
import { enabledProvidersOf, field, providerSelection, record, RemoteError, sharesSessions } from '../core/domain.js';
/** Owns backend instances, connection identity/status and the saved machine model catalog. */
export class HostConnections {
    store;
    factory;
    serial;
    created;
    connections = new Map();
    catalogListeners = new Set();
    closed = false;
    constructor(store, factory, serial, created) {
        this.store = store;
        this.factory = factory;
        this.serial = serial;
        this.created = created;
    }
    get stopped() { return this.closed; }
    /** Observation only: never constructs a backend, even after shutdown. */
    peek(hostId) { return this.connections.get(hostId)?.backend; }
    /** Local backend access; does not probe SSH or attach a saved CLI. */
    backend(hostId) { return this.connection(hostId).backend; }
    hosts() {
        return this.store.hosts().map(({ password, catalog, ...host }) => {
            const enabled = enabledProvidersOf(host), providers = catalog?.providers.filter(p => enabled.includes(p.id)) ?? [];
            // An unreachable host already reports its own error.
            const connection = this.connections.get(host.id), shareError = sharesSessions(host) && connection?.status === 'connected' ? connection.backend.sharingError?.() : undefined;
            return { ...host, enabledProviders: enabled, share: sharesSessions(host), ...(shareError ? { shareError: this.safeError(shareError) } : {}), status: this.connections.get(host.id)?.status ?? 'disconnected', error: this.connections.get(host.id)?.error,
                ...(!enabled.length ? { modelCount: 0 } : {}),
                ...(catalog ? { modelsCheckedAt: catalog.checkedAt, modelCount: providers.filter(p => p.status === 'ready').reduce((n, p) => n + p.models.length, 0),
                    providerErrors: providers.filter(p => p.status === 'error').map(p => ({ label: p.label, error: p.error ?? '' })) } : {}) };
        });
    }
    host(id) {
        const host = this.store.hosts().find(h => h.id === id);
        if (!host)
            throw new RemoteError('Remote host not found', 404);
        return host;
    }
    safeError(error) {
        let message = error instanceof Error ? error.message : String(error);
        for (const host of this.store.hosts())
            if (host.password)
                message = message.split(host.password).join('[redacted]');
        return message.slice(0, 2000);
    }
    connection(hostId) {
        if (this.closed)
            throw new RemoteError('Remote agent service has stopped', 503);
        let connection = this.connections.get(hostId);
        if (!connection) {
            connection = { backend: this.factory(this.host(hostId)), status: 'disconnected' };
            this.connections.set(hostId, connection);
            this.created(hostId, connection.backend);
        }
        return connection;
    }
    async use(hostId, action, expectedServerId) {
        let host = this.host(hostId);
        const current = this.connection(hostId);
        // Only the connection speaks for the host. An action can fail for reasons of its own, such as a missing file or a CLI's error.
        try {
            if (!current.ready) {
                current.status = 'connecting';
                current.ready = (async () => {
                    const serverId = await current.backend.connect();
                    host = this.host(hostId);
                    if (host.serverId && host.serverId !== serverId)
                        throw new RemoteError('Remote SSH machine identity changed. Add it as a new host before starting new agents.', 409);
                    if (!host.serverId)
                        await this.store.update(state => {
                            const saved = state.hosts.find(h => h.id === hostId);
                            if (!saved)
                                throw new RemoteError('Remote host was removed', 409);
                            if (saved.serverId && saved.serverId !== serverId)
                                throw new RemoteError('Remote SSH machine identity changed', 409);
                            saved.serverId = serverId;
                        });
                    current.status = 'connected';
                    current.error = undefined;
                    current.backend.startSharing?.();
                })();
            }
            await current.ready;
            host = this.host(hostId);
            // Recheck the SSH execution identity before each operation.
            const serverId = await current.backend.connect();
            if (serverId !== host.serverId)
                throw new RemoteError('Remote SSH machine identity changed', 409);
        }
        catch (error) {
            current.status = 'error';
            current.error = this.safeError(error);
            current.ready = undefined;
            // Independent SSH sessions keep running when another probe or request fails.
            throw new RemoteError(current.error, error instanceof RemoteError ? error.status : 502);
        }
        try {
            if (expectedServerId && host.serverId !== expectedServerId)
                throw new RemoteError('Agent belongs to a different remote SSH machine', 409);
            void current.backend.cleanup?.();
            return await action(current.backend, host);
        }
        catch (error) {
            throw new RemoteError(this.safeError(error), error instanceof RemoteError ? error.status : 502);
        }
    }
    onCatalogChange(listener) { this.catalogListeners.add(listener); return () => this.catalogListeners.delete(listener); }
    catalogChanged() { for (const listener of this.catalogListeners)
        listener(); }
    /** Discover once per machine, independent of any configured project. Failed probes keep the saved catalog. */
    async discoverHost(hostId) {
        await this.serial(`catalog:${hostId}`, async () => {
            const host = this.host(hostId);
            if (!enabledProvidersOf(host).length) {
                await this.store.update(state => { const saved = state.hosts.find(h => h.id === hostId); if (saved)
                    delete saved.modelError; });
                this.catalogChanged();
                return;
            }
            try {
                const catalog = await this.use(hostId, async (backend) => {
                    const cwd = await backend.homeDirectory();
                    return { cwd, providers: await backend.providers(cwd, true), checkedAt: new Date().toISOString() };
                });
                await this.store.update(state => {
                    const host = state.hosts.find(h => h.id === hostId);
                    if (!host)
                        throw new RemoteError('Remote host was removed', 409);
                    host.catalog = catalog;
                    delete host.modelError;
                });
            }
            catch (error) {
                await this.store.update(state => { const host = state.hosts.find(h => h.id === hostId); if (host)
                    host.modelError = this.safeError(error); });
            }
            this.catalogChanged();
        });
    }
    async setHostProviders(hostId, value) {
        const selection = providerSelection(value);
        await this.serial(`catalog:${hostId}`, async () => {
            this.host(hostId);
            await this.store.update(state => {
                const host = state.hosts.find(h => h.id === hostId);
                if (!host)
                    throw new RemoteError('Remote host was removed', 409);
                host.enabledProviders = selection;
                delete host.modelError;
            });
            this.catalogChanged();
        });
        return this.discoverHost(hostId);
    }
    async addHost(input) {
        const value = record(input);
        const host = { id: randomUUID(), label: field(value.label, 'host name', 100), connection: connectionInput(value.connection) };
        if (value.enabledProviders !== undefined)
            host.enabledProviders = providerSelection(value.enabledProviders);
        if (value.password)
            throw new RemoteError('SSH uses keys or an SSH agent; password storage is not supported');
        await this.store.update(state => {
            if (state.hosts.length >= 16)
                throw new RemoteError('Up to 16 remote hosts can be saved');
            if (state.hosts.some(h => h.connection === host.connection))
                throw new RemoteError('This remote host is already saved', 409);
            state.hosts.push(host);
        });
        return host.id;
    }
    /** Remove before closing, so the next access uses the latest saved host configuration. */
    async release(hostId) {
        const connection = this.connections.get(hostId);
        this.connections.delete(hostId);
        await connection?.backend.close();
    }
    /** Close backends before draining service mutations: close unblocks pending CLI starts. */
    async closeBackends() {
        this.closed = true;
        await Promise.allSettled([...this.connections.values()].map(c => c.backend.close()));
    }
    /** Called only after the facade has drained its shared mutation queue. */
    clear() { this.connections.clear(); }
}
