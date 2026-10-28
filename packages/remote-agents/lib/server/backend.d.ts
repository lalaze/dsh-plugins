import type { AccountUsage, Agent, Attachment, Choice, Cursor, DirectoryListing, HostConfig, MessageTimeline, Model, PermissionAnswer, Provider, Task, TimelinePage } from './domain.js';
import { type SshTransport } from './ssh.js';
import type { Store } from './store.js';
import { WorkspaceFiles } from './workspace-files.js';
export { connectionInput } from './ssh.js';
/** Agent state, replies and timelines are local reads; only process control needs the SSH host. */
export interface Backend {
    workspaceFiles?: WorkspaceFiles;
    connect(): Promise<string>;
    close(): Promise<void>;
    homeDirectory(): Promise<string>;
    /** Canonicalize a directory (`~` expands to the remote home) and optionally list its subdirectories. */
    listDirectory?(path: string | undefined, options?: {
        entries?: boolean;
    }): Promise<DirectoryListing>;
    providers(cwd: string, refresh: boolean): Promise<Provider[]>;
    create(task: Task, signal?: AbortSignal): Promise<Agent>;
    recover(task: Task, signal?: AbortSignal): Promise<Agent>;
    agent(id: string): Promise<Agent | null>;
    timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
    messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
    reply(id: string): Promise<string>;
    /** Interrupts a running turn first and reattaches a detached session. */
    send(id: string, text: string, messageId: string, attachments?: Attachment[], signal?: AbortSignal): Promise<void>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, answer: PermissionAnswer, input?: Record<string, unknown>): Promise<void>;
    /** Stop and release the CLI process; output and the native session ID are kept. */
    detach(task: Task): Promise<void>;
    /** Detach and delete saved output. */
    forget(task: Task): Promise<void>;
    /** Plan limits of the account a CLI is signed in with; null when the CLI does not report them. */
    account(provider: string, cwd: string | undefined, refresh: boolean): Promise<AccountUsage | null>;
    /** Reattach to a CLI still running under a relay, without waiting for SSH. */
    restore?(task: Task): Promise<Agent | null>;
    /** Stop and delete relays queued for removal on this host. */
    cleanup?(): Promise<void>;
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
/** Codex speed tiers. `serviceTiers` carries request IDs such as `priority`; older CLIs only list `additionalSpeedTiers` names. */
export declare function codexServiceTiers(model: Record<string, unknown>): Choice[] | undefined;
export declare class SshBackend implements Backend {
    private readonly host;
    private readonly store;
    readonly workspaceFiles: WorkspaceFiles;
    private readonly transport;
    private closed;
    private readonly probes;
    private identity?;
    private catalogs;
    private sessions;
    private histories;
    private starting;
    private accounts;
    /** Tasks with an operation in flight; their sessions are never evicted. */
    private leases;
    private relayClient?;
    /** Why the last relay check failed; CLIs are not started until it succeeds. */
    private relayUnavailable?;
    private ending;
    private cleaning?;
    constructor(host: HostConfig, store: Store, transport?: SshTransport);
    private assertOpen;
    homeDirectory(): Promise<string>;
    listDirectory(path: string | undefined, options?: {
        entries?: boolean;
    }): Promise<DirectoryListing>;
    connect(): Promise<string>;
    private history;
    providers(cwd: string, refresh: boolean): Promise<Provider[]>;
    private task;
    /** Hosts with Node.js 18+ run CLIs under a relay; transports without relay support keep a direct SSH pipe. */
    private relays;
    /** Forget a relay locally and remove it remotely now, or once the host is reachable. */
    private relayEnded;
    /** Stop and delete relays queued for this host. Never blocks local deletion or archiving. */
    cleanup(): Promise<void>;
    /** A link to a relay, installing the current relay script on the host before attaching. */
    private link;
    private session;
    /**
     * Reattach to the relay still running this task's CLI. Needs no SSH connection: the link keeps
     * reconnecting, and the turn, tools and pending permissions are rebuilt from the saved history.
     */
    restore(task: Task): Promise<Agent | null>;
    private lease;
    create(task: Task, signal?: AbortSignal): Promise<Agent>;
    recover(task: Task, signal?: AbortSignal): Promise<Agent>;
    private start;
    private open;
    agent(id: string): Promise<Agent | null>;
    timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage>;
    messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<MessageTimeline>;
    reply(id: string): Promise<string>;
    /** A restored relay session once it is connected, or undefined when its CLI has ended. */
    private reattach;
    /** The live session, resuming the saved native session when the process is gone. */
    private attached;
    send(id: string, text: string, messageId: string, attachments?: Attachment[], signal?: AbortSignal): Promise<void>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, answer: PermissionAnswer): Promise<void>;
    detach(task: Task): Promise<void>;
    forget(task: Task): Promise<void>;
    account(provider: string, cwd: string | undefined, refresh: boolean): Promise<AccountUsage | null>;
    /** Ask a running session of this CLI, or briefly start one without a prompt. */
    private readAccount;
    /** Shutdown releases persistent sessions, which keep running and are restored on the next start. */
    close(): Promise<void>;
}
