import { type Backend, type BackendFactory } from './backend.js';
import type { Store } from '../core/store.js';
import { type Host, type HostConfig } from '../core/domain.js';
/** The facade supplies its single queue, shared by host configuration and task mutations. */
type Serial = <T>(key: string, action: () => Promise<T>) => Promise<T>;
/** Owns backend instances, connection identity/status and the saved machine model catalog. */
export declare class HostConnections {
    private readonly store;
    private readonly factory;
    private readonly serial;
    private readonly created;
    private readonly connections;
    private readonly catalogListeners;
    private closed;
    constructor(store: Store, factory: BackendFactory, serial: Serial, created: (hostId: string, backend: Backend) => void);
    get stopped(): boolean;
    /** Observation only: never constructs a backend, even after shutdown. */
    peek(hostId: string): Backend | undefined;
    /** Local backend access; does not probe SSH or attach a saved CLI. */
    backend(hostId: string): Backend;
    hosts(): Host[];
    host(id: string): HostConfig;
    safeError(error: unknown): string;
    private connection;
    use<T>(hostId: string, action: (backend: Backend, host: HostConfig) => Promise<T>, expectedServerId?: string): Promise<T>;
    onCatalogChange(listener: () => void): () => void;
    catalogChanged(): void;
    /** Discover once per machine, independent of any configured project. Failed probes keep the saved catalog. */
    discoverHost(hostId: string): Promise<void>;
    setHostProviders(hostId: string, value: unknown): Promise<void>;
    addHost(input: unknown): Promise<string>;
    /** Remove before closing, so the next access uses the latest saved host configuration. */
    release(hostId: string): Promise<void>;
    /** Close backends before draining service mutations: close unblocks pending CLI starts. */
    closeBackends(): Promise<void>;
    /** Called only after the facade has drained its shared mutation queue. */
    clear(): void;
}
export {};
