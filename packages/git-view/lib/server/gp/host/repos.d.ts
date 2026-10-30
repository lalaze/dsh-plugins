/** Directories the scanner descends into, cwd-relative depth. Deep enough for
 * the common group/project layout, shallow enough that one scan stays cheap. */
export declare const REPO_SCAN_DEPTH = 3;
/** Directory ceiling for one scan: a workspace with a huge tree stops early
 * instead of walking everything on every panel mount. */
export declare const REPO_SCAN_LIMIT = 2000;
/** Repository ceiling for one result list; past this the switcher would be
 * unusable anyway, and the client addresses entries by path, not index. */
export declare const REPO_RESULT_LIMIT = 50;
/** The filesystem face the scanner needs — a structural subset of the host's
 * snapshot deps, so production wiring and tests pass the same shape. */
export interface RepoFs {
    readonly realpath: (path: string) => Promise<string>;
    readonly stat: (path: string) => Promise<unknown>;
    readonly readdir: (path: string) => Promise<readonly {
        readonly name: string;
        readonly isDirectory: boolean;
    }[]>;
}
/** One nested repository found below the cwd. */
export interface ScannedRepo {
    /** cwd-relative path, POSIX separators. */
    readonly path: string;
    /** Absolute realpath of the work-tree top. */
    readonly root: string;
    /** Display name (the directory's basename). */
    readonly name: string;
}
/** Windows path comparison is case-insensitive; POSIX is not. */
export declare function samePath(a: string, b: string): boolean;
/** True when `target` is `root` or sits inside it. */
export declare function isWithin(root: string, target: string): boolean;
/** cwd-relative POSIX path of `target`, or null when it escapes `root`. */
export declare function relativeRepoPath(root: string, target: string): string | null;
/**
 * Breadth-first scan of `cwd` for repository roots. A directory with a
 * `.git` is a root and is not descended into (its own nested repositories, if
 * any, belong to it, not to the workspace). Symlinked directories are skipped
 * because the dirent reports them as non-directories. Bounded by depth, scan
 * count and result count; the result is sorted by path so the switcher order is
 * stable.
 */
export declare function scanRepos(fs: RepoFs, cwd: string, opts?: {
    readonly depth?: number;
    readonly scanLimit?: number;
    readonly resultLimit?: number;
}): Promise<ScannedRepo[]>;
/**
 * Resolve a repository selector to the directory inside the session cwd.
 *
 * Rejects anything that is not a safe relative path, anything that realpaths
 * outside the cwd (absolute paths and `..` never reach realpath; a symlink
 * that escapes does), the cwd itself (that is the empty selector), and a
 * `.git` directory. Whether the directory is a work-tree top is decided by the
 * caller, which asks git.
 */
export declare function repoDirFor(fs: RepoFs, cwd: string, rel: string): Promise<{
    readonly ok: true;
    readonly dir: string;
} | {
    readonly ok: false;
}>;
