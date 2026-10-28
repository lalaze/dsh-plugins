import { type BackendFactory } from './backend.js';
import { Store } from './store.js';
import { readSshConfigHosts } from './ssh-config.js';
import type { WorkspaceFiles } from './workspace-files.js';
import { type AgentDetail, type AgentState, type AgentSummary, type Cursor, type Dashboard, type DirectoryListing, type Host, type Task, type UsageReport } from './domain.js';
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
    signal?: AbortSignal;
    /** Recheck a workspace-bound request after discovery and immediately before CLI execution. */
    beforeStart?(): Promise<void>;
}
export interface SendOptions {
    /** Interrupt a running turn. When false, a working agent rejects the message. */
    interrupt?: boolean;
    signal?: AbortSignal;
}
export declare class RemoteAgentsService {
    readonly store: Store;
    private readonly readSshConfig;
    private readonly connections;
    private readonly locks;
    private readonly catalogListeners;
    private closed;
    private readonly factory;
    constructor(store: Store, factory?: BackendFactory, readSshConfig?: typeof readSshConfigHosts);
    sshConfig(): Promise<import("./domain.js").SshConfigHosts>;
    /** Reuse the agent host's transport and machine-identity checks for workspace operations. */
    withWorkspace<T>(hostId: string, verify: () => Promise<void>, action: (files: WorkspaceFiles) => Promise<T>): Promise<T>;
    hosts(): Host[];
    /** Closed for a plugin reload or DSH shutdown; remote work must not be stopped then. */
    get stopped(): boolean;
    /**
     * Reattach persistent CLIs after a restart and finish queued relay cleanups. Runs in the
     * background: hosts may be offline, and their sessions keep reconnecting until they return.
     */
    resume(): Promise<void>;
    onCatalogChange(listener: () => void): () => void;
    private catalogChanged;
    /** Discover once per machine, independent of any configured project. Failed probes keep the saved catalog. */
    discoverHost(hostId: string): Promise<Dashboard>;
    setHostProviders(hostId: string, value: unknown): Promise<Dashboard>;
    snapshot(): Promise<Dashboard>;
    private host;
    private task;
    private safeError;
    private serial;
    private connection;
    private use;
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
    providers(hostId: string, cwd: string, refresh?: boolean): Promise<import("./domain.js").Provider[]>;
    private updateTask;
    create(input: unknown, options?: CreateOptions): Promise<AgentSummary>;
    /** Retry an interrupted start, or reattach a stopped session without replaying anything. */
    retry(id: string, signal?: AbortSignal): Promise<AgentSummary>;
    private launch;
    private assertAgent;
    state(id: string): Promise<AgentState>;
    /** Saved output stays readable while the SSH host is offline. */
    detail(id: string, cursor?: Cursor, direction?: 'before' | 'after'): Promise<AgentDetail>;
    reply(id: string): Promise<string>;
    messageTimeline(id: string, messageId: string, cursor?: Cursor): Promise<import("./domain.js").MessageTimeline>;
    setThinking(id: string, thinkingOptionId?: string): Promise<void>;
    /** Change a model or speed by resuming the same native session. Existing receipts keep their original namespace. */
    setModel(id: string, model: string, thinkingOptionId?: string, route?: string, serviceTier?: string): Promise<void>;
    /** Context comes from local state; only plan limits are read from the SSH host, and they are cached. */
    usage(sessionId: string, options?: UsageOptions): Promise<UsageReport | null>;
    rename(id: string, title: string): Promise<AgentSummary>;
    send(id: string, input: unknown, options?: SendOptions): Promise<AgentSummary>;
    stop(id: string): Promise<void>;
    respond(id: string, requestId: string, input: unknown): Promise<void>;
    /** Soft delete: interrupt, release the CLI process and hide the agent. Output and the native session are kept. */
    archive(id: string, archived?: boolean, options?: {
        onlyIdle?: boolean;
    }): Promise<AgentSummary>;
    delete(id: string): Promise<void>;
    /** Applies from the next message: the idle session is released and resumed with the new mode. */
    setMode(id: string, modeId: string): Promise<AgentSummary>;
    close(): Promise<void>;
}
