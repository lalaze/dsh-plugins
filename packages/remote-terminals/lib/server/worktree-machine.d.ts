import { posix } from 'node:path';
import type { RemoteAgentsMachines } from './core/machines.js';
/** One Git command's outcome; `code` is null for a command that was stopped or timed out. */
export interface GitResult {
    code: number | null;
    stdout: string;
    stderr: string;
}
export interface GitStep {
    argv: string[];
    timeoutMs?: number;
}
type PathModule = Pick<typeof posix, 'join' | 'relative' | 'resolve' | 'dirname' | 'basename' | 'isAbsolute' | 'sep'>;
/**
 * Where a worktree's Git, files and setup commands run: this computer, or a saved SSH machine. Paths are the machine's
 * own absolute paths.
 */
export interface WorktreeMachine {
    readonly kind: 'local' | 'remote';
    readonly path: PathModule;
    /** The user's home directory on the machine. */
    home(signal?: AbortSignal): Promise<string>;
    /** Git commands in order in `cwd`. A failing command does not stop the others. `reads` marks commands that only read. */
    git(cwd: string, steps: GitStep[], options?: {
        reads?: boolean;
        signal?: AbortSignal;
    }): Promise<GitResult[]>;
    /** A shell command for as long as it takes; both output streams go to `output`. Resolves the exit code, null when stopped. */
    shell(cwd: string, command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
    /** A text file, or undefined when it is missing or larger than `limit` bytes. */
    read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
    exists(target: string, signal?: AbortSignal): Promise<boolean>;
    /** Removes a directory and everything in it. */
    removeTree(target: string, signal?: AbortSignal): Promise<void>;
}
/** This computer, where DSH runs. */
export declare class LocalMachine implements WorktreeMachine {
    private readonly options;
    readonly kind: "local";
    readonly path: PathModule;
    constructor(options?: {
        git?: string;
    });
    home(): Promise<string>;
    git(cwd: string, steps: GitStep[], options?: {
        reads?: boolean;
        signal?: AbortSignal;
    }): Promise<GitResult[]>;
    shell(cwd: string, command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
    read(file: string, limit: number): Promise<string | undefined>;
    exists(target: string): Promise<boolean>;
    removeTree(target: string): Promise<void>;
}
/** A saved SSH machine, through its verified connection: only `sh`, standard utilities and Git are needed there. */
export declare class RemoteMachine implements WorktreeMachine {
    private readonly machines;
    readonly hostId: string;
    readonly kind: "remote";
    readonly path: PathModule;
    private homePath?;
    constructor(machines: Pick<RemoteAgentsMachines, 'browse' | 'withWorkspace'>, hostId: string);
    private files;
    home(): Promise<string>;
    git(cwd: string, steps: GitStep[], options?: {
        reads?: boolean;
        signal?: AbortSignal;
    }): Promise<GitResult[]>;
    shell(cwd: string, command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
    read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
    exists(target: string, signal?: AbortSignal): Promise<boolean>;
    removeTree(target: string, signal?: AbortSignal): Promise<void>;
}
export {};
