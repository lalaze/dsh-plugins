import { type SshTransport } from '../core/ssh.js';
import { type Agent, type SharedWorkspace } from '../core/domain.js';
import type { TaskHistory } from './history.js';
import type { Store } from '../core/store.js';
/** `claimed`: this DSH now drives the session; `changed` means its history was replaced by the shared one. */
export interface Acquired {
    status: 'claimed' | 'held' | 'deleted' | 'unavailable';
    changed?: boolean;
}
/** What a shared host needs from the backend that runs its CLIs. */
export interface SharedOwner {
    readonly hostId: string;
    history(taskId: string): Promise<TaskHistory>;
    /** The CLI session this DSH drives, while it has not handed it over. */
    live(taskId: string): Agent | undefined;
    /** Another DSH took the session over: stop reading its CLI here. The CLI keeps running. */
    yield(taskId: string): void;
    /** Another DSH deleted the session: forget it here without touching its CLI. */
    removed(taskId: string): Promise<void>;
    /** A CLI nobody drives is still running: drive it from here. */
    adopt(taskId: string): void;
    /** Whether the task's history is open here, for example because it is on screen or its CLI is attached. */
    loaded(taskId: string): boolean;
    /** Close a history nothing uses, to free its memory. */
    unload(taskId: string): void;
}
/**
 * The sessions of one SSH host, shared with every DSH connected to the same SSH account. The registry
 * on the host holds each session's record and history. Exactly one DSH at a time holds a session's
 * lease: it drives the CLI and appends the history; the others follow the history. Any DSH takes the
 * lease over when it sends, answers or stops, and drives a CLI whose lease expired.
 */
export declare class SharedSessions {
    private readonly transport;
    private readonly store;
    private readonly owner;
    private peer?;
    private instance?;
    private ttl;
    private started;
    private closed;
    private listed;
    private connecting;
    private attempt;
    private timer?;
    private publishTimer?;
    private ticker?;
    private refreshedAt;
    /** Requests fail at once while the host cannot run the registry, for example without Node.js 18. */
    private unavailable?;
    error?: string;
    workspaces: SharedWorkspace[];
    private readonly waiters;
    /** Changes reported while the full list is applied; they follow it in order. */
    private queued;
    private applying;
    private readonly sessions;
    /** The shared record as last seen, to tell local edits from remote ones. */
    private readonly known;
    private readonly checked;
    /** How much of each history the host is known to hold exactly as here. */
    private readonly acked;
    private readonly offsets;
    private readonly held;
    private readonly lives;
    private readonly chains;
    private readonly pushes;
    private readonly adopting;
    private readonly listener;
    constructor(transport: SshTransport, store: Store, owner: SharedOwner);
    private get me();
    /** Another DSH's name; one on the same computer as this one is told apart by its ID. */
    private name;
    start(): void;
    /** The registry is reachable and its sessions were applied. */
    get connected(): boolean;
    /** Why sharing does not work right now, if it does not. */
    status(): string | undefined;
    private connect;
    private retry;
    /** `retryNow` skips a pending backoff; otherwise only a connection already under way is awaited. */
    private ready;
    private call;
    /** Operations on one session run in order. */
    private serial;
    private fresh;
    /** Started sessions of this host, as it is identified now: those of a machine whose identity changed belong to the earlier one. */
    private publishable;
    private changed;
    /** Apply the host's sessions. A full list also publishes the sessions the host does not have yet. */
    private reconcile;
    private update;
    /** A CLI still running on the host whose DSH went away, or never had one, is driven from here. */
    private adoptIfOrphaned;
    /** Take a shared record into the local copy, importing sessions other DSH instances started. */
    private apply;
    private schedulePublish;
    /** Send the fields changed here since the shared record was last seen. */
    private publish;
    /** A session recorded here that the host does not know: publish it with its history. */
    private backfill;
    /** Publish a task's record now, for a change other DSH instances must see before acting, such as a new relay. */
    flush(id: string): Promise<void>;
    /** Bring a history another DSH drives up to date before it is read here. Never throws; gives up after `timeout`. */
    catchUp(id: string, timeout?: number): Promise<void>;
    /** Copy new history to the host while this DSH drives the session. */
    appended(id: string): void;
    private push;
    /** History here and on the host diverged while this DSH held the lease: take the shared history and drive the CLI again from it. */
    private resync;
    /** Another DSH took the session over: drop what this DSH recorded but never copied. */
    private lost;
    private pull;
    /** Make the local history equal the host's first `target` entries. Returns whether it changed. */
    private download;
    /**
     * Make this DSH the one driving a session. With `force` the lease is taken from another DSH;
     * without it only a free or expired one is. The local record and history then match the host's.
     */
    acquire(id: string, force: boolean, timeout?: number, retryNow?: boolean): Promise<Acquired>;
    /** Whether a relay may be attached from here. Never blocks a CLI when the registry cannot be reached. */
    mayAttach(id: string): Promise<boolean>;
    /** Publish live status and keep the leases of driven CLIs from expiring. */
    private tick;
    /** Live status reported by the DSH driving the session, when that is another one. */
    remoteLive(id: string): Partial<Agent> | undefined;
    /** The other DSH driving a session, by name. */
    controller(id: string): string | undefined;
    /** Delete a session for every DSH; the deletion is kept until the host can be reached. */
    delete(id: string): Promise<void>;
    /**
     * Stop sharing sessions started here: each is caught up from the host and taken over, then removed from the
     * registry, so other DSH instances forget it. Needs the host unless sharing never worked there.
     */
    withdraw(ids: string[]): Promise<void>;
    /** Whether the registry answers now, connecting at once if needed. A host that cannot run it shares nothing. */
    reachable(timeout: number): Promise<boolean>;
    /** Let another DSH drive a session right away. */
    release(id: string): Promise<void>;
    addWorkspace(path: string): Promise<void>;
    /** Workspaces any DSH added on this SSH account. */
    listWorkspaces(timeout?: number): Promise<SharedWorkspace[]>;
    close(): void;
}
