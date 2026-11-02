import { type HubInfo, type HubMessage, type LocalAction, type LocalStatus, type Method, type PushPreferences, type PushSubscriptionJson, type TagState } from '../shared/protocol.js';
import { Executor } from './bridge/executor.js';
import type { HostApi } from './bridge/host.js';
import { Store, type PhoneRecord } from './store.js';
export declare class HttpError extends Error {
    readonly status: number;
    name: string;
    constructor(message: string, status?: number);
}
/** dsh-workspace-tags' host service, when installed. */
export interface WorkspaceTagsService {
    snapshot(): TagState;
    subscribe?(listener: (state: TagState) => void): () => void;
}
export interface HubOptions {
    stateDir: string;
    host: HostApi;
    tags?: () => WorkspaceTagsService | undefined;
    version: string;
    /** Initial settings for a new state; the settings page changes them later. */
    defaults?: {
        name?: string;
        relay?: string;
        appUrl?: string;
    };
    log?(message: string): void;
    WebSocket?: typeof WebSocket;
    fetch?: typeof fetch;
}
export declare class Hub {
    private readonly options;
    readonly store: Store;
    readonly executor: Executor;
    private relay?;
    private offer?;
    private readonly requests;
    private readonly connections;
    private readonly lastFinished;
    private changedTimer?;
    private stops;
    private constructor();
    static open(options: HubOptions): Promise<Hub>;
    get state(): import("./store.js").State;
    private log;
    start(): Promise<void>;
    close(): Promise<void>;
    private restartRelay;
    /** Tell phones when tags change. Workspace Tags may load after this plugin, so look for it until it is there. */
    private followTags;
    tags(): TagState;
    online(phoneId: string): boolean;
    /** A phone's socket from the relay, before the handshake. */
    accept(socket: WebSocket, connectionId: string): void;
    info(phoneKey: string): HubInfo;
    phoneByKey(key: string): PhoneRecord | undefined;
    requestPairing(phoneKey: string, args: {
        token?: unknown;
        name?: unknown;
        platform?: unknown;
    }): Promise<HubInfo>;
    private confirm;
    private reject;
    status(): LocalStatus;
    action(input: LocalAction): Promise<unknown>;
    private phone;
    private notifyChanged;
    setPush(phone: PhoneRecord, subscription: PushSubscriptionJson | undefined, preferences?: PushPreferences): void;
    push(phone: PhoneRecord, notification: {
        title: string;
        body: string;
        tag: string;
        sessionId?: string;
    }): Promise<void>;
    /** Notify phones when a session starts waiting for an answer, or finishes a turn. */
    private observe;
    /** Run one method for a connection. */
    call(connection: Connection, method: Method, args: unknown, stream: (frame: unknown) => void, signal: AbortSignal): Promise<unknown>;
}
/** One phone's connection through the relay: handshake first, then encrypted requests and streams. */
export declare class Connection {
    private readonly hub;
    private readonly socket;
    readonly connectionId: string;
    phoneKey?: string;
    private channel?;
    private readonly controllers;
    private idle?;
    private ended;
    constructor(hub: Hub, socket: WebSocket, connectionId: string);
    get phone(): PhoneRecord | undefined;
    private touch;
    private frame;
    send(message: HubMessage): void;
    changed(cursor: string): void;
    paired(): void;
    /** Grants changed: streams the phone may no longer read end. */
    updated(): void;
    revoke(message: string): void;
    close(code: number, reason: string): void;
    closed(): void;
}
export declare function normalizeRelay(text: string): {
    relay: string;
    tls: boolean;
};
export declare function normalizeAppUrl(text: string): string;
