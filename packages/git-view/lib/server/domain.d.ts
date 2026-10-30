/** Browser-safe contracts of the Git routes. Paths are POSIX, relative to the repository root unless said otherwise. */
/** Where a conversation's Git runs: on the DSH machine, or over SSH in a Remote Agents remote workspace. */
export type Location = {
    kind: 'local';
} | {
    kind: 'remote';
    host: string;
    cwd: string;
};
export interface Branch {
    /** `main` for a local branch, `origin/main` for a remote one. */
    name: string;
    sha: string;
    short: string;
    /** Committer date, ISO 8601. */
    date: string;
    subject: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    /** The upstream branch no longer exists. */
    gone?: boolean;
    current: boolean;
}
export interface Commit {
    sha: string;
    parents: string[];
    author: string;
    date: string;
    subject: string;
}
/**
 * One `git status` entry: its two-letter porcelain code, the path from the repository root, the original path of a rename,
 * and the path from the workspace folder when the file is inside it.
 */
export interface Change {
    code: string;
    path: string;
    from?: string;
    local?: string;
}
export interface Summary {
    location: Location;
    repo: string;
    current: string;
}
export interface Status {
    location: Location;
    prefix: string;
    changes: Change[];
}
/** `prefix` is the workspace folder's path inside the repository, such as `app/` or empty at its root. */
export interface Overview extends Summary, Status {
    local: Branch[];
    remote: Branch[];
    commits: Commit[];
    tips: Record<string, string>;
}
export type WorkingFile = {
    kind: 'text';
    content: string;
    revision: string;
    size: number;
} | {
    kind: 'binary' | 'large';
    size: number;
} | {
    kind: 'missing';
};
export type HeadFile = {
    kind: 'text';
    content: string;
} | {
    kind: 'binary' | 'large';
} | {
    kind: 'absent';
};
/** A workspace file at HEAD and in the working tree; `path` is relative to the workspace folder, `repoPath` to the repository root. */
export interface Comparison {
    location: Location;
    path: string;
    repoPath: string;
    head: HeadFile;
    working: WorkingFile;
    code?: string;
}
export interface Done {
    output: string;
}
export interface CredentialTarget {
    host?: string;
    username?: string;
}
/** Files compared and edited in the diff view. */
export declare const TEXT_LIMIT: number;
/** Sent by the client; links, forms and images from other pages cannot add it. */
export declare const CLIENT_HEADER = "X-DSH-Git-View";
/** Conversations whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export declare const REMOTE_ANCHOR: RegExp;
