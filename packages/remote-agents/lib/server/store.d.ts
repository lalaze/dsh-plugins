import { type ChatProject, type HostConfig, type Task, type TurnUsage } from './domain.js';
/** A relay to stop and delete on its SSH host once it is reachable. */
export interface RelayCleanup {
    hostId: string;
    relayId: string;
}
export interface State {
    version: 1;
    hosts: HostConfig[];
    tasks: Task[];
    mainChatProjects?: ChatProject[];
    relayCleanups?: RelayCleanup[];
}
export declare class Store {
    private readonly path;
    private state;
    private writes;
    /** The file content this instance last read or wrote; undefined when the file did not exist. */
    private saved?;
    private closed;
    /** Listeners for the tokens each finished CLI turn used; the plugin forwards them to usage statistics. */
    readonly usageListeners: Set<(taskId: string, usage: TurnUsage, turn: {
        startedAt: string | null;
        failed: boolean;
    }) => void>;
    constructor(path: string);
    get directory(): string;
    open(): Promise<void>;
    snapshot(): State;
    /** Copies of the saved hosts, without cloning agent records. Lookups run on every dashboard poll. */
    hosts(): HostConfig[];
    chatProjects(): ChatProject[];
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
