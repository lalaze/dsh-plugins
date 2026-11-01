import { type TagOperation, type TagState, type WorkspaceTag } from '../shared/tags.js';
/** Serialized atomic snapshots: a failed write leaves both the file and the in-memory state unchanged. */
export declare class TagStore {
    private readonly path;
    private state;
    private queue;
    private readonly listeners;
    /**
     * Changes on each saved state. Starts from a per-process random epoch, so a client polling with a revision from
     * before a host restart always reloads.
     */
    private counter;
    private readonly epoch;
    constructor(path: string);
    load(): Promise<void>;
    snapshot(): TagState;
    /** Opaque value that changes whenever the saved state does. */
    revision(): string;
    /** Called after each saved change, with the new state. */
    subscribe(listener: (state: TagState) => void): () => void;
    apply(operation: TagOperation): Promise<{
        state: TagState;
        tag?: WorkspaceTag;
    }>;
    /**
     * Save a whole state at once, for host plugins that merge tags from elsewhere (dsh-device-sync). The state is
     * normalized like a stored file, so invalid tags and assignments are dropped rather than saved.
     */
    replace(next: TagState): Promise<{
        state: TagState;
    }>;
    private write;
}
