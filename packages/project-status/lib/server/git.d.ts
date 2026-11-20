import nodePath from 'node:path';
export interface GitStep {
    argv: string[];
    timeoutMs?: number;
}
export interface GitResult {
    code: number | null;
    stdout: string;
    stderr: string;
}
/** Runs the commands in order in one folder. A command that fails is an answer, not an error. */
export type Git = (steps: GitStep[], signal?: AbortSignal) => Promise<GitResult[]>;
/** The folder a conversation works in, and how to ask Git about it there. */
export interface Workplace {
    folder: string;
    git: Git;
    /** The machine's path rules: this computer's, or POSIX on a machine reached over SSH. */
    path: Pick<typeof nodePath, 'resolve' | 'basename' | 'dirname' | 'sep'>;
    /** Present when the folder is on another machine. */
    remote?: {
        hostId: string;
        label: string;
    };
}
/** Git on this computer. */
export declare function localGit(folder: string): Git;
/** The part of dsh-remote-terminals' `remoteAgentsWorktrees` service used here: Git in a workspace on a saved machine. */
export interface RemoteWorktrees {
    machine(path: string, signal?: AbortSignal): Promise<{
        location: {
            kind: 'local';
        } | {
            kind: 'remote';
            hostId: string;
            host: string;
        };
        folder: string;
        git(steps: GitStep[], options?: {
            reads?: boolean;
            signal?: AbortSignal;
        }): Promise<GitResult[]>;
    }>;
}
/**
 * Where a workspace's files are. A local folder is asked directly, so a conversation that moved into a worktree DSH does
 * not list as a workspace still works; an anchor of a remote workspace goes through the plugin that holds the connection.
 */
export declare function workplace(folder: string, remoteAnchor: boolean, worktrees: RemoteWorktrees | undefined, signal?: AbortSignal): Promise<Workplace>;
