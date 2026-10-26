import type { Agent, Cursor, HostConfig, MessageTimeline, Model, PermissionAnswer, Provider, Task, TimelinePage } from './domain.js';
import { type SshTransport } from './ssh.js';
import type { Store } from './store.js';
export { connectionInput } from './ssh.js';
/** Agent state, replies and timelines are local reads; only process control needs the SSH host. */
export interface Backend {
    connect(): Promise<string>;
    close(): Promise<void>;
    homeDirectory(): Promise<string>;
    providers(cwd: string, refresh: boolean): Promise<Provider[]>;
    create(task: Task): Promise<Agent>;
    recover(task: Task): Promise<Agent>;
    agent(id: string): Promise<Agent | null>;
    timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
    messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
    reply(id: string): Promise<string>;
    /** Interrupts a running turn first and reattaches a detached session. */
    send(id: string, text: string, messageId: string): Promise<void>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, answer: PermissionAnswer, input?: Record<string, unknown>): Promise<void>;
    /** Stop and release the CLI process; output and the native session ID are kept. */
    detach(task: Task): Promise<void>;
    /** Detach and delete saved output. */
    forget(task: Task): Promise<void>;
}
export type BackendFactory = (host: HostConfig) => Backend;
export declare const CLI_PROVIDERS: ({
    id: string;
    label: string;
    command: string;
    protocol: "claude";
    args: never[];
} | {
    id: string;
    label: string;
    command: string;
    protocol: "codex";
    args: string[];
} | {
    id: string;
    label: string;
    command: string;
    protocol: "acp";
    args: string[];
} | {
    id: string;
    label: string;
    command: string;
    protocol: "antigravity";
    args: never[];
})[];
/** Claude's `list_models` control response: `supportedEffortLevels` holds per-model reasoning choices. */
export declare function claudeModels(result: unknown): Model[];
export declare class SshBackend implements Backend {
    private readonly host;
    private readonly store;
    private readonly transport;
    private closed;
    private readonly probes;
    private identity?;
    private catalogs;
    private sessions;
    private histories;
    private starting;
    /** Tasks with an operation in flight; their sessions are never evicted. */
    private leases;
    constructor(host: HostConfig, store: Store, transport?: SshTransport);
    private assertOpen;
    homeDirectory(): Promise<string>;
    connect(): Promise<string>;
    private history;
    providers(cwd: string, refresh: boolean): Promise<Provider[]>;
    private task;
    private lease;
    create(task: Task): Promise<Agent>;
    recover(task: Task): Promise<Agent>;
    private start;
    private open;
    agent(id: string): Promise<Agent | null>;
    timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
    messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
    reply(id: string): Promise<string>;
    /** The live session, resuming the saved native session when the process is gone. */
    private attached;
    send(id: string, text: string, messageId: string): Promise<void>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, answer: PermissionAnswer): Promise<void>;
    detach(task: Task): Promise<void>;
    forget(task: Task): Promise<void>;
    close(): Promise<void>;
}
