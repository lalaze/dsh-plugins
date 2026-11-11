export interface RetiredEntry {
    from: string;
    to: string;
    at: string;
}
export interface Failure {
    path: string;
    error: string;
}
export interface Moved {
    moved: {
        from: string;
        to: string;
    }[];
    failed: Failure[];
}
export interface TagFile {
    tags: Record<string, string[]>;
    notes: Record<string, string>;
}
export declare const TAG_LIMIT = 40, TAGS_PER_IMAGE = 20, NOTE_LIMIT = 2000;
/** A tag as kept: trimmed, single-spaced, without commas or control characters; undefined when nothing usable is left. */
export declare function cleanTag(value: unknown): string | undefined;
/**
 * A retired folder as the user may set it: a plain relative path of visible names, such as `_retired` or
 * `assets/art-retired`. Hidden folders are not scanned, so retired images there could not be listed or restored.
 */
export declare function cleanRetireDir(value: unknown): string | undefined;
export declare function readRetired(root: string, retireDir: string): Promise<RetiredEntry[]>;
export declare function readTags(root: string): Promise<TagFile>;
/** Changes to one workspace, one at a time, so two requests cannot both rewrite the retired list or the tag file. */
export declare class Library {
    private readonly root;
    private last;
    /** `root` is the workspace folder with symbolic links resolved. */
    constructor(root: string);
    private queue;
    /**
     * Moves one file. The source must be a regular image inside the workspace and the target free; folders on either
     * side may not be links leading out of the workspace.
     */
    private move;
    private moveTags;
    private moveAll;
    /** Removes the folders a move left empty, from each given file's folder up to, but not including, `top`. */
    private prune;
    /** Moves images into the retired folder, each under its own path, and records where it came from. */
    retire(retireDir: string, paths: readonly string[]): Promise<Moved>;
    /** Moves retired images back where the list says they came from, and removes the folders this leaves empty. */
    restore(retireDir: string, paths: readonly string[]): Promise<Moved>;
    /** Adds and removes tags on each path; answers the tags those paths have afterwards. */
    tag(paths: readonly string[], add: readonly string[], remove: readonly string[]): Promise<Record<string, string[]>>;
    /** Sets an image's note; an empty note removes it. */
    note(path: string, note: string): Promise<string>;
}
