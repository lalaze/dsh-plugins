import { type ChatProject, type HostConfig, type FinishedTurn, type Task, type TurnUsage } from './domain.js';
/** A relay to stop and delete on its SSH host once it is reachable. */
export interface RelayCleanup {
    hostId: string;
    relayId: string;
}
/**
 * `chatEfforts` maps a native chat model route to the reasoning effort of its last explicit picker selection;
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
/** This DSH instance, as the others saw it while 0.2.138 and earlier shared sessions between them. */
export interface Instance {
    id: string;
    label: string;
}
/**
 * `instance` is kept as saved: withdrawing names it. `sharedWithdrawals` lists, per host, the sessions 0.2.138 and earlier
 * shared with other DSH instances and that are still to be withdrawn from the host's registry; see {@link Store.open}.
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
    sharedWithdrawals?: Record<string, string[]>;
    /**
     * What 0.2.129 and earlier saved about TUI conversations. dsh-remote-terminals took them over and keeps them now; they
     * stay here untouched, so that it can find them on its first start and an older version still has them.
     */
    tuiSessions?: string[];
    tuiDetails?: Record<string, unknown>;
    tuiLocalScroll?: boolean;
}
/** This computer's name as the local machine's label, `lalaze-mini.local` shown as `lalaze-mini`. */
export declare function localMachineLabel(name?: string): string;
export declare class Store {
    private readonly path;
    private readonly options;
    private state;
    private writes;
    /** The file content this instance last read or wrote; undefined when the file did not exist. */
    private saved?;
    private closed;
    /** Listeners for the tokens each finished CLI turn used; the plugin forwards them to usage statistics. */
    readonly usageListeners: Set<(taskId: string, usage: TurnUsage, turn: FinishedTurn) => void>;
    /** Called after every saved change. */
    readonly changeListeners: Set<() => void>;
    /** Machines whose saved model catalog lost Antigravity models from 0.2.129 or earlier on opening; see {@link oldAntigravity}. */
    readonly staleCatalogs: Set<string>;
    /** `localMachine` adds this computer's machine ({@link LOCAL_HOST_ID}) when the saved state has none. */
    constructor(path: string, options?: {
        localMachine?: boolean;
    });
    get directory(): string;
    open(): Promise<void>;
    private load;
    snapshot(): State;
    /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
    hosts(): HostConfig[];
    chatProjects(): ChatProject[];
    /** A copy of the sharing settings; read for every shared tool listing and call. */
    sharing(): SharingSettings;
    /** Whether a DSH conversation's Codex turns use the Fast speed. */
    chatFast(sessionId: string): boolean;
    /** The reasoning effort last explicitly selected for a native chat model route, if any. */
    chatEffort(route: string): string | undefined;
    /** The identity this DSH had while sessions were shared, if it ever reached a host's registry. */
    savedInstance(): Instance | undefined;
    /** Sessions of a host still to be withdrawn from its shared registry. */
    sharedWithdrawals(hostId: string): string[];
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
