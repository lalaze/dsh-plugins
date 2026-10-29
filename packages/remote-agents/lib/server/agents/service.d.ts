import { type BackendFactory } from './backend.js';
import type { LaunchSharing } from '../sharing/sharing.js';
import { Store } from '../core/store.js';
import { readSshConfigHosts } from '../core/ssh-config.js';
import type { WorkspaceFiles } from '../workspace/files.js';
import { type AgentDetail, type AgentState, type AgentSummary, type Cursor, type Dashboard, type DirectoryListing, type Host, type SharedWorkspace, type Task, type UsageReport } from '../core/domain.js';
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
    private readonly restoring;
    private readonly catalogListeners;
    private closed;
    private readonly factory;
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
    /** `everywhere` also deletes a shared host's sessions for the other DSH instances. */
    removeHost(id: string, options?: {
        deleteAgents?: boolean;
        everywhere?: boolean;
    }): Promise<Dashboard>;
    /** Share this host's sessions and workspaces with other DSH instances, or stop. CLIs keep running either way. */
    setHostSharing(hostId: string, share: unknown): Promise<Dashboard>;
    private forgetLocal;
    /** Remote workspaces other DSH instances added on this host that were not offered to this DSH yet. */
    sharedWorkspaces(hostId: string): Promise<SharedWorkspace[]>;
    /** Offered to DSH: not offered again, even when removed from the sidebar. */
    seeWorkspaces(hostId: string, paths: string[]): Promise<void>;
    /** Record a remote workspace on its host so other DSH instances offer it too. */
    shareWorkspace(hostId: string, path: string): Promise<void>;
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
    /** Soft delete: interrupt, release the CLI process and hide the agent. Output and the native session are kept. */
    archive(id: string, archived?: boolean, options?: {
        onlyIdle?: boolean;
    }): Promise<AgentSummary>;
    delete(id: string): Promise<void>;
    /** Applies from the next message: the idle session is released and resumed with the new mode. */
    setMode(id: string, modeId: string): Promise<AgentSummary>;
    close(): Promise<void>;
}
