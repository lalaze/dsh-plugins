import type { AccountUsage, Agent, Attachment, Choice, Cursor, DirectoryListing, HostConfig, MessageTimeline, Model, PermissionAnswer, Provider, SharedTag, SharedWorkspace, Task, TimelinePage } from '../core/domain.js';
import { type SshTransport } from '../core/ssh.js';
import type { Store } from '../core/store.js';
import { WorkspaceFiles } from '../workspace/files.js';
import { type LaunchSharing } from '../sharing/sharing.js';
export { connectionInput } from '../core/ssh.js';
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
    /** Probe just the one CLI a session targets, to validate its model, mode and speed without launching the others. */
    target(cwd: string, providerId: string): Promise<Provider>;
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
    /** Start sharing sessions with other DSH instances connected to the same SSH account. */
    startSharing?(): void;
    /** Why sharing does not work right now, while it is switched on. */
    sharingError?(): string | undefined;
    /** The other DSH driving a shared session, by name. */
    controller?(taskId: string): string | undefined;
    /** Forget a session here only: a shared one stays on the host for other DSH instances, and its CLI keeps running. */
    forgetLocal?(task: Task): Promise<void>;
    sharedWorkspaces?(timeout?: number): Promise<SharedWorkspace[]>;
    /** Called when the host reports its shared workspaces changed; returns the unsubscribe function. */
    onSharedWorkspaces?(listener: () => void): () => void;
    /**
     * Called with a task whose history grew without a message from this DSH: one another DSH drives, after it was brought
     * up to date here, or one whose CLI ran a turn by itself; returns the unsubscribe function.
     */
    onSharedHistory?(listener: (taskId: string) => void): () => void;
    /** How far a shared session has been read and how far its history goes; nothing when it is not shared. */
    readPosition?(taskId: string): {
        read: number;
        head: number;
    } | undefined;
    /** The user read a shared session as far as this DSH has it. */
    markRead?(taskId: string): Promise<void>;
    /** Called with a task whose read position changed, here or on another DSH; returns the unsubscribe function. */
    onSharedRead?(listener: (taskId: string) => void): () => void;
    /** Who sent a message a shared history records with its sender: this DSH, or another one by name. */
    sender?(instance: string, label: string): {
        self: true;
    } | {
        name: string;
    };
    shareWorkspace?(path: string): Promise<void>;
    setWorkspaceTags?(path: string, tags: SharedTag[]): Promise<SharedWorkspace>;
    /** Stop sharing the given sessions started here; other DSH instances forget them. */
    withdrawSharing?(taskIds: string[]): Promise<void>;
    /** Whether deletions reach the other DSH instances now; true without sharing. */
    sharingReachable?(timeout: number): Promise<boolean>;
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
/**
 * Nobody approves an unattended Claude task's commands. With workspace write it runs them in Claude Code's own sandbox,
 * which confines writes to the workspace like DSH's sandbox; without a sandbox on the host they are asked and denied.
 * Read-only gets no sandbox, since it would have to widen what a read-only task's commands can read while it can reach
 * the web; but searching and reading the web change nothing, and research would otherwise be refused every time.
 * Codex's read-only sandbox already allows web search.
 *
 * `confined` says the sandbox is known to work on this host (see {@link confinesCommands}). Claude Code then exits rather
 * than run without it and ignores a command's request to leave it, so its commands can be left to the sandbox.
 */
export declare const unattendedClaude: (task: Pick<Task, "unattended" | "modeId">, confined?: boolean) => string[];
/**
 * Whether an unattended Claude's commands can be left to its sandbox rather than refused. Only macOS has been measured:
 * on Linux it also needs bwrap and socat, and without them Claude Code runs commands unsandboxed.
 */
export declare function confinesCommands(system: string, version: string): boolean;
/**
 * Claude Code refuses to skip permissions as root unless IS_SANDBOX says the machine is meant for it. Whoever connects as
 * root and picks Full access, or made it that account's default, has decided that, so these launches say so. The host is
 * asked because any account name can have uid 0. It is set around the launch rather than by a wrapper command: the relay
 * recognizes its CLI by the command it started.
 */
export declare const CLAUDE_ROOT_ENV = "if [ \"$(id -u)\" = 0 ]; then export IS_SANDBOX=1; fi; ";
export declare class SshBackend implements Backend {
    private readonly host;
    private readonly store;
    private readonly sharing;
    readonly workspaceFiles: WorkspaceFiles;
    private readonly transport;
    private closed;
    private readonly probes;
    private identity?;
    private catalogs;
    private readonly confining;
    /** One CLI's probe for the start path, keyed by `cwd\0provider`, so `create` and `open` do not probe twice. */
    private targets;
    private sessions;
    /** Admitted starts/restores, including work not yet registered in sessions. */
    private readonly reservations;
    private histories;
    /** When each loaded history was last used, so idle ones (no live session) are freed from memory. */
    private readonly historyUsed;
    private historySweep?;
    /** How long a history with no live session is kept in memory after its last read, before it is reloaded on demand. */
    readonly historyTtl = 300000;
    private starting;
    private accounts;
    /** The plan each CLI's account last showed, for answers that cannot tell it. */
    private plans;
    /** Tasks with an operation in flight; their sessions are never evicted. */
    private leases;
    private relayClient?;
    /** Why the last relay check failed; CLIs are not started until it succeeds. */
    private relayUnavailable?;
    private ending;
    private restoring;
    private cleaning?;
    /** Sessions shared with other DSH instances on the same SSH account; needs relays. */
    private readonly shared?;
    private readonly historyListeners;
    private readonly readListeners;
    constructor(host: HostConfig, store: Store, transport?: SshTransport, sharing?: () => LaunchSharing | undefined);
    startSharing(): void;
    sharingError(): string | undefined;
    controller(taskId: string): string | undefined;
    onSharedHistory(listener: (taskId: string) => void): () => void;
    readPosition(taskId: string): {
        read: number;
        head: number;
    } | undefined;
    markRead(taskId: string): Promise<void>;
    onSharedRead(listener: (taskId: string) => void): () => void;
    sender(instance: string, label: string): {
        self: true;
    } | {
        name: string;
    };
    sharedWorkspaces(timeout?: number): Promise<SharedWorkspace[]>;
    onSharedWorkspaces(listener: () => void): () => void;
    setWorkspaceTags(path: string, tags: SharedTag[]): Promise<SharedWorkspace>;
    shareWorkspace(path: string): Promise<void>;
    sharingReachable(timeout: number): Promise<boolean>;
    withdrawSharing(taskIds: string[]): Promise<void>;
    /**
     * Drive a shared session from this DSH before acting on its CLI, taking it over from another DSH.
     * Without a reachable registry the action goes ahead as before.
     */
    private control;
    private assertOpen;
    homeDirectory(): Promise<string>;
    listDirectory(path: string | undefined, options?: {
        entries?: boolean;
    }): Promise<DirectoryListing>;
    connect(): Promise<string>;
    private history;
    /**
     * Drop histories no live session uses and nothing has read for a while; a later read reopens them from disk.
     * A history an attached, restoring or starting session holds is kept: a second instance of the same file would
     * append or read out of step with the one that session holds.
     */
    private sweepHistories;
    /** Canonical cwd and the installed path of each probed CLI, in one SSH round trip. */
    private canonicalize;
    /** Probe one CLI in its canonical cwd: its models and modes, and the launch profile when it is ready. */
    private probeDefinition;
    providers(cwd: string, refresh: boolean): Promise<Provider[]>;
    /**
     * Probe only the one CLI a session needs, rather than launching every enabled CLI to list its models.
     * Cached briefly so a session's validation (`create`) and its launch (`open`) share a single probe.
     */
    private resolveTarget;
    /** The one CLI a session targets, probed in its own cwd, for `create` to validate the model, mode and speed. */
    target(cwd: string, providerId: string): Promise<Provider>;
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
    private reconnect;
    /** Synchronous admission: no async launch/restore can pass the same last free slot. */
    private reserve;
    private lease;
    create(task: Task, signal?: AbortSignal): Promise<Agent>;
    recover(task: Task, signal?: AbortSignal): Promise<Agent>;
    private start;
    /** Asked once per CLI: what the host is and which Claude Code it runs. Anything unclear keeps commands refused. */
    private confines;
    private open;
    agent(id: string): Promise<Agent | null>;
    /** A history another DSH drives is brought up to date before it is read. */
    private read;
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
    private takeOver;
    detach(task: Task): Promise<void>;
    forget(task: Task): Promise<void>;
    forgetLocal(task: Task): Promise<void>;
    private removeFiles;
    /** Another DSH deleted a shared session: forget it here. Its CLI was stopped by that DSH. */
    private removeLocal;
    account(provider: string, cwd: string | undefined, refresh: boolean): Promise<AccountUsage | null>;
    /** Ask a running session of this CLI, or briefly start one without a prompt. */
    private readAccount;
    /** Shutdown releases persistent sessions, which keep running and are restored on the next start. */
    close(): Promise<void>;
}
