import type { SharedTag, SharedWorkspace } from '../core/domain.js';
import type { Store } from '../core/store.js';
/** dsh-workspace-tags' host service, version 1: tags by id, and each workspace's tag ids. */
export interface WorkspaceTagsService {
    readonly version: number;
    snapshot(): TagState;
    replace(state: TagState): Promise<TagState>;
    subscribe(listener: (state: TagState) => void): () => void;
}
interface TagState {
    tags: {
        id: string;
        name: string;
        color: string;
    }[];
    assignments: Record<string, string[]>;
}
export interface TagSyncHost {
    tags(): WorkspaceTagsService | undefined;
    /** DSH's workspaces, as its workspace controller lists them. */
    workspaces(): readonly {
        workspaceId: string;
        path: string;
    }[];
    /** The sharing hosts and remote directory a workspace folder stands for; none for a local workspace. */
    targets(path: string): Promise<{
        hostId: string;
        remotePath: string;
    }[]>;
    /** The host's shared workspaces with their tags, or undefined while its registry cannot be reached. */
    shared(hostId: string): Promise<SharedWorkspace[] | undefined>;
    publish(hostId: string, remotePath: string, tags: SharedTag[]): Promise<SharedWorkspace>;
    warn?(message: string): void;
}
/**
 * Keeps Workspace Tags alike on every DSH that shares a remote workspace: a workspace is known by its host and remote
 * directory, a tag by its name, as workspace and tag ids differ between DSH instances. A change made here is published
 * to the host's shared registry; a newer one found there is applied here. The first time a workspace is compared, tags
 * on both sides are combined, so a DSH that has none never clears another's.
 */
export declare class WorkspaceTagSync {
    private readonly store;
    private readonly host;
    private readonly options;
    private timer?;
    private due;
    private running?;
    private again;
    private closed;
    private unsubscribe?;
    private readonly warned;
    constructor(store: Store, host: TagSyncHost, options?: {
        every?: number;
        delay?: number;
    });
    start(): void;
    close(): void;
    /** Compare soon, as after a change on either side. */
    trigger(): void;
    private schedule;
    /** One comparison of every shared workspace; rounds never overlap. */
    run(): Promise<void>;
    private round;
    private sync;
    /** A workspace's tags here, by name and color, in the order they were added. */
    private local;
    /** Give the workspace exactly these tags, creating the ones this DSH does not have with the color they came with. */
    private assign;
    private remember;
}
export {};
