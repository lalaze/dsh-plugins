/**
 * Workspace tags: free-text names with a palette color, assigned to DSH
 * Workspaces by id. Shared by the host store and the sidebar client; every
 * change goes through {@link applyTagOperation}, so both halves agree on what
 * a valid state is.
 */
/** Host route: GET returns `{ state }`, POST applies one {@link TagOperation} and returns `{ state, tag? }` or `{ error }`. */
export declare const TAGS_ROUTE = "/api/workspace-tags";
/** Palette ids; the client maps each to a light and a dark color. */
export declare const TAG_COLORS: readonly ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "amber", "lime", "emerald", "cyan", "sky", "indigo", "violet", "fuchsia", "rose"];
export type TagColor = typeof TAG_COLORS[number];
export declare const TAG_NAME_MAX = 40;
export declare const TAG_LIMIT = 200;
export interface WorkspaceTag {
    id: string;
    name: string;
    color: TagColor;
}
/** Tags in creation order, and each Workspace's tag ids in the order they were added. */
export interface TagState {
    tags: WorkspaceTag[];
    assignments: Record<string, string[]>;
}
export type TagOperation = {
    op: 'create';
    name: string;
    color: TagColor;
    assignTo?: string;
} | {
    op: 'update';
    id: string;
    name?: string;
    color?: TagColor;
} | {
    op: 'delete';
    id: string;
}
/** Toggling one tag at a time keeps two clients' edits to the same Workspace from overwriting each other. */
 | {
    op: 'assign';
    workspaceId: string;
    tagId: string;
    assigned: boolean;
}
/** Drop a deleted Workspace's assignments. */
 | {
    op: 'forget';
    workspaceId: string;
};
/** A rejected operation; its message is shown to the user. */
export declare class TagError extends Error {
    name: string;
}
export declare const emptyTagState: () => TagState;
/** Trim and check a tag name; names are unique ignoring case. */
export declare function tagName(value: unknown, tags: readonly WorkspaceTag[], self?: string): string;
/**
 * Apply one operation without mutating `state`.
 * @param newId - id for a created tag.
 * @returns the next state and, for `create`, the new tag.
 * @throws TagError when the operation is invalid for this state.
 */
export declare function applyTagOperation(state: TagState, operation: TagOperation, newId: () => string): {
    state: TagState;
    tag?: WorkspaceTag;
};
/**
 * Read a stored or received state, dropping what does not fit instead of
 * failing: invalid tags, duplicate names, and assignments to unknown tags.
 */
export declare function parseTagState(value: unknown): TagState;
