import { type BackendFactory } from './backend.js';
import type { LaunchSharing } from '../sharing/sharing.js';
import { Store } from '../core/store.js';
import { readSshConfigHosts } from '../core/ssh-config.js';
import type { WorkspaceFiles } from '../workspace/files.js';
import { type AgentDetail, type AgentState, type AgentSummary, type Cursor, type Dashboard, type DirectoryListing, type Host, type Task, type TimelinePage, type UsageReport } from '../core/domain.js';
export interface UsageOptions {
    /** The conversation's selected route; picks its CLI when the conversation used several. */
    route?: string;
    /** Machine and CLI of the selected route, for a conversation that has not started a session yet. */
    target?: {
        hostId: string;
        provider: string;
    };
    /** Also read plan limits, which may contact the SSH host. */
    account?: boolean;
    refresh?: boolean;
}
export interface CreateOptions {
    title?: string;
    origin?: Task['origin'];
    chat?: Task['chat'];
    owner?: Task['owner'];
    signal?: AbortSignal;
    /** For a DSH subagent nobody answers; see {@link Task.unattended}. */
    unattended?: boolean;
    /** Recheck a workspace-bound request after discovery and immediately before CLI execution. */
    beforeStart?(): Promise<void>;
}
export interface SendOptions {
    /** Interrupt a running turn. When false, a working agent rejects the message. */
    interrupt?: boolean;
    signal?: AbortSignal;
}
/** How old a machine's saved models get, while conversations work there, before they are checked again in the background. */
export declare const CATALOG_MAX_AGE_MS = 3600000;
export declare class RemoteAgentsService {
    readonly store: Store;
    private readonly readSshConfig;
    private readonly hostConnections;
    /** Told a task whose CLI runs a turn by itself, when the turn starts and when it ends; its conversation shows the turn. */
    readonly ownTurnListeners: Set<(taskId: string) => void>;
    private readonly locks;
    private readonly restoring;
    private readonly delegationRecovery;
    /** When each machine's saved models were last checked in the background, successfully or not. */
    private readonly catalogChecks;
    /** DSH's MCP servers and skills for remote CLIs; set once DSH's registries are available. */
    sharing?: LaunchSharing;
    constructor(store: Store, factory?: BackendFactory, readSshConfig?: typeof readSshConfigHosts);
    sshConfig(): Promise<import("../core/domain.js").SshConfigHosts>;
    /** Reuse the agent host's transport and machine-identity checks for workspace operations. */
    withWorkspace<T>(hostId: string, verify: () => Promise<void>, action: (files: WorkspaceFiles) => Promise<T>): Promise<T>;
    hosts(): Host[];
    /** Closed for a plugin reload or DSH shutdown; remote work must not be stopped then. */
    get stopped(): boolean;
    /** Reattach one saved CLI without making any other saved session connect to its host. */
    private restore;
    /**
     * Reattach persistent CLIs after a restart and finish queued relay cleanups. Runs in the
     * background: hosts may be offline, and their sessions keep reconnecting until they return.
     * This is deliberately explicit: plugin startup restores only conversations DSH actually opens.
     */
    resume(hostId?: string): Promise<void>;
    /** Reattach only the remote tasks behind one open DSH conversation; unrelated hosts stay offline. */
    resumeConversation(sessionId: string): Promise<void>;
    /** Observe only this conversation's delegated CLIs, including saved/archived history.
     * Recovery attaches existing relays only; it never starts a new CLI or sends a prompt.
     * Do not use snapshot/resume here: opening one conversation must not connect unrelated hosts.
     */
    delegations(sessionId: string): Promise<AgentSummary[]>;
    private observeDelegation;
    onCatalogChange(listener: () => void): () => void;
    /** Discover once more, in the background, the machines whose saved catalog lost an outdated entry on opening. */
    refreshStaleCatalogs(): Promise<void>;
    /**
     * Detect this computer's CLIs, once while DSH runs, when a conversation works in one of its folders and none is ready:
     * the first time, or after none was installed. A CLI installed here later shows up after Refresh models, a restart, or
     * {@link refreshAgedCatalogs}. Starting DSH detects nothing, as it connects to no machine.
     */
    discoverLocalMachine(): Promise<void>;
    private localDiscovery?;
    /**
     * Check again, in the background, the saved models of the machines a conversation works on once they are
     * {@link CATALOG_MAX_AGE_MS} old, so a CLI's new models reach the picker without Refresh models. The composer asks on
     * every window focus: each machine is checked at most once per period, whatever the outcome. Only machines already
     * discovered are checked; one never discovered waits for Refresh models or {@link discoverLocalMachine}.
     */
    refreshAgedCatalogs(hostIds: readonly string[], now?: number): Promise<void>;
    discoverHost(hostId: string): Promise<Dashboard>;
    setHostProviders(hostId: string, value: unknown): Promise<Dashboard>;
    snapshot(): Promise<Dashboard>;
    private task;
    private serial;
    /** Local process state; never contacts the SSH host. */
    private live;
    private summarize;
    summary(id: string): Promise<AgentSummary>;
    /** One directory level on a verified host; `path` defaults to the remote home. */
    browse(hostId: string, path?: string, options?: {
        entries?: boolean;
    }): Promise<DirectoryListing>;
    addHost(input: unknown, options?: {
        discoverModels?: boolean;
    }): Promise<Dashboard>;
    removeHost(id: string, options?: {
        deleteAgents?: boolean;
    }): Promise<Dashboard>;
    connect(hostId: string): Promise<Dashboard>;
    providers(hostId: string, cwd: string, refresh?: boolean): Promise<import("../core/domain.js").Provider[]>;
    private updateTask;
    create(input: unknown, options?: CreateOptions): Promise<AgentSummary>;
    /** Retry an interrupted start, or reattach a stopped session without replaying anything. */
    retry(id: string, signal?: AbortSignal): Promise<AgentSummary>;
    private launch;
    private assertAgent;
    state(id: string): Promise<AgentState>;
    /** Saved output stays readable while the SSH host is offline. */
    detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<AgentDetail>;
    /** Saved output only: nothing is restored or attached, so reading many sessions never connects their relays. */
    timeline(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<TimelinePage | null>;
    reply(id: string): Promise<string>;
    messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<import("../core/domain.js").MessageTimeline>;
    setThinking(id: string, thinkingOptionId?: string): Promise<void>;
    /** Change a model or speed by resuming the same native session. Existing receipts keep their original namespace. */
    setModel(id: string, model: string, thinkingOptionId?: string, route?: string, serviceTier?: string): Promise<void>;
    /** Context comes from local state; only plan limits are read from the SSH host, and they are cached. */
    usage(sessionId: string, options?: UsageOptions): Promise<UsageReport | null>;
    rename(id: string, title: string): Promise<AgentSummary>;
    send(id: string, input: unknown, options?: SendOptions): Promise<AgentSummary>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, input: unknown): Promise<void>;
    /** Archives every session working in a remote folder or below it, as when a worktree is removed. */
    archiveSessionsIn(hostId: string, folder: string): Promise<void>;
    /** Soft delete: interrupt, release the CLI process and hide the agent. Output and the native session are kept. */
    archive(id: string, archived?: boolean, options?: {
        onlyIdle?: boolean;
    }): Promise<AgentSummary>;
    /**
     * Ends an idle CLI's process on its host; the session itself stays and its next message resumes it. A finished
     * subagent would otherwise hold one of the account's relay slots until someone archives it.
     */
    release(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    /** Applies from the next message: the idle session is released and resumed with the new mode. */
    setMode(id: string, modeId: string): Promise<AgentSummary>;
    close(): Promise<void>;
}
