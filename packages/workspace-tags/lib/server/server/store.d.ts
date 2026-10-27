import { type TagOperation, type TagState, type WorkspaceTag } from '../shared/tags.js';
/** Serialized atomic snapshots: a failed write leaves both the file and the in-memory state unchanged. */
export declare class TagStore {
    private readonly path;
    private state;
    private queue;
    constructor(path: string);
    load(): Promise<void>;
    snapshot(): TagState;
    apply(operation: TagOperation): Promise<{
        state: TagState;
        tag?: WorkspaceTag;
    }>;
}
