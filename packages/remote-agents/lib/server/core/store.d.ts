import { type ChatProject, type HostConfig, type FinishedTurn, type Task, type TurnUsage } from './domain.js';
/** A relay to stop and delete on its SSH host once it is reachable. */
export interface RelayCleanup {
    hostId: string;
    relayId: string;
}
/**
 * `chatEfforts` maps a native chat model route to the reasoning effort its last conversation turn used;
 * `chatFast` lists the DSH conversations whose Codex turns run at the Fast speed.
 */
/**
 * What DSH shares with remote CLIs: MCP servers switched on (off by default), skills switched off (on by default),
 * and the secret that derives each task's bridge token.
 */
export interface SharingSettings {
    mcp?: Record<string, boolean>;
    skills?: Record<string, boolean>;
    secret?: string;
}
/** This DSH instance, as other instances sharing an SSH host's sessions see it. */
export interface Instance {
    id: string;
    label: string;
}
/**
 * `instance` identifies this DSH to others sharing a host's sessions; `seenWorkspaces` lists, per host, the
 * shared remote workspaces already offered to DSH, so one removed from the sidebar is not added again.
 */
export interface State {
    version: 1;
    hosts: HostConfig[];
    tasks: Task[];
    mainChatProjects?: ChatProject[];
    relayCleanups?: RelayCleanup[];
    chatEfforts?: Record<string, string>;
    chatFast?: string[];
    sharing?: SharingSettings;
    instance?: Instance;
    seenWorkspaces?: Record<string, string[]>;
    sharedDeletions?: SharedDeletion[];
}
/** A deleted shared session whose deletion has not reached its SSH host yet. */
export interface SharedDeletion {
    hostId: string;
    id: string;
}
export declare class Store {
    private readonly path;
    private state;
    private writes;
    /** The file content this instance last read or wrote; undefined when the file did not exist. */
    private saved?;
    private closed;
    /** Listeners for the tokens each finished CLI turn used; the plugin forwards them to usage statistics. */
    readonly usageListeners: Set<(taskId: string, usage: TurnUsage, turn: FinishedTurn) => void>;
    /** Called after every saved change; shared hosts publish the task records that changed. */
    readonly changeListeners: Set<() => void>;
    constructor(path: string);
    get directory(): string;
    open(): Promise<void>;
    snapshot(): State;
    /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
    hosts(): HostConfig[];
    chatProjects(): ChatProject[];
    /** A copy of the sharing settings; read for every shared tool listing and call. */
    sharing(): SharingSettings;
    /** The reasoning effort a native chat model route last used, if any. */
    /** Whether a DSH conversation's Codex turns use the Fast speed. */
    chatFast(sessionId: string): boolean;
    chatEffort(route: string): string | undefined;
    /** This DSH's identity for shared hosts, created on first use. */
    instance(): Promise<Instance>;
    seenWorkspaces(hostId: string): string[];
    sharedDeletions(hostId: string): string[];
    relayCleanups(hostId: string): RelayCleanup[];
    /** A copy of one saved agent record, without cloning the whole registry. */
    task(predicate: (task: Task) => boolean): Task | undefined;
    tasks(predicate: (task: Task) => boolean): Task[];
    /** Serialize read/modify/atomic-rename, including concurrent HTTP requests. */
    update(change: (next: State) => void): Promise<void>;
    flush(): Promise<void>;
    /** Finish queued writes, then refuse new ones: a closed instance must not overwrite its successor's state. */
    close(): Promise<void>;
}
