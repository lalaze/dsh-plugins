/** Shared, browser-safe workspace contracts. Paths are relative to a verified workspace. */
/** The launcher's file name, which DSH's terminal shell menu shows as the item label. */
export declare const TERMINAL_LAUNCHER = "Remote workspace";
/** `terminalShell` is the Remote workspace launcher path, as listed in DSH's terminal shell menu. */
export interface WorkspaceTarget {
    hostId: string;
    label: string;
    cwd: string;
    terminalShell?: string;
}
export interface WorkspaceEntry {
    name: string;
    path: string;
    kind: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    modified: string;
}
export interface WorkspaceFile {
    path: string;
    content: string;
    revision: string;
    size: number;
}
export interface WorkspaceManifest {
    files: Record<string, {
        hash: string;
        size: number;
    }>;
    skipped: string[];
}
export type FileOperation = {
    op: 'list';
    path: string;
} | {
    op: 'read';
    path: string;
} | {
    op: 'stat';
    path: string;
} | {
    op: 'webStart';
    path: string;
    port: number;
    host: string;
} | {
    op: 'webStop';
    path: string;
    port: number;
} | {
    op: 'write';
    path: string;
    content: string;
    revision: string | null;
} | {
    op: 'mkdir';
    path: string;
} | {
    op: 'remove';
    path: string;
    revision: string;
} | {
    op: 'move';
    path: string;
    destination: string;
    revision: string;
} | {
    op: 'manifest';
    path: string;
} | {
    op: 'search';
    path: string;
    query: string;
} | {
    op: 'command';
    path: string;
    command: string;
    timeoutMs?: number;
};
/** One Git invocation: its arguments without `git` itself, and how long it may run. */
export interface GitCommand {
    argv: string[];
    timeoutMs: number;
}
/**
 * Git commands run in order, in one SSH round trip, in the workspace directory `path`. `id`, a UUID, names the request
 * for `cancelGit`. With `stopOnError` a failure skips the rest; reads pass `optionalLocks: false`. `maxBytes` limits each
 * command's standard output.
 */
export interface GitBatch {
    id: string;
    path?: string;
    commands: GitCommand[];
    maxBytes: number;
    stopOnError?: boolean;
    optionalLocks?: boolean;
}
/** `exitCode` is null for a command that was stopped or skipped. */
export interface GitRun {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    skipped: boolean;
}
export declare const GIT_LIMITS: {
    readonly commands: 16;
    readonly arguments: 64;
    readonly bytes: number;
    readonly output: number;
    readonly timeoutMs: 170000;
    readonly totalMs: 280000;
};
export interface SyncChange {
    path: string;
    action: 'copy' | 'delete';
    source: string | null;
    destination: string | null;
}
export interface SyncResult {
    direction: 'pull' | 'push';
    dryRun: boolean;
    changes: SyncChange[];
    conflicts: string[];
    skipped: string[];
    planId?: string;
}
export interface TunnelConfig {
    id: string;
    hostId: string;
    direction: 'local' | 'reverse';
    listenPort: number;
    targetPort: number;
    targetHost: string;
}
export interface Tunnel extends TunnelConfig {
    status: 'starting' | 'running' | 'stopped' | 'error';
    error?: string;
}
export declare const FILE_LIMIT: number;
export declare const TEXT_LIMIT: number;
