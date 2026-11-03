import { type FileOperation, type GitBatch, type GitRun } from './domain.js';
import { type SshTransport } from '../core/ssh.js';
export declare class WorkspaceFiles {
    private readonly transport;
    constructor(transport: SshTransport);
    /** Runs one shell operation and returns its data; the program reports handled failures with their status. */
    private run;
    /** Remote DSH runs on Node.js, so only its own operations need it on the host. */
    private remoteDsh;
    operate(cwd: string, operation: FileOperation, signal?: AbortSignal): Promise<unknown>;
    download(cwd: string, path: string, revision: string, signal?: AbortSignal): Promise<Buffer>;
    /** A file by absolute path, read from its own directory, or undefined when it is larger than `limit` bytes. */
    readAbsolute(path: string, limit: number, signal?: AbortSignal): Promise<Buffer | undefined>;
    upload(cwd: string, path: string, revision: string | null, size: number, input: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<unknown>;
    /** Runs Git commands in one round trip. The SSH host passes the whole program as one argument, so arguments stay small. */
    git(cwd: string, batch: GitBatch, signal?: AbortSignal): Promise<GitRun[]>;
    /** Stops a running `git` request and the commands it has not started. */
    cancelGit(cwd: string, id: string, signal?: AbortSignal): Promise<void>;
    /**
     * A shell command in `cwd` with the login environment and `env`, for as long as it takes, as for a worktree's setup.
     * Both output streams arrive together as they are written. Resolves the exit code; aborting stops the command and
     * every process it started, and resolves null.
     */
    stream(cwd: string, command: string, env: Record<string, string>, output: (data: Buffer) => void, signal: AbortSignal): Promise<number | null>;
}
