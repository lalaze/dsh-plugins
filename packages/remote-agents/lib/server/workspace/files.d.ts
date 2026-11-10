import { type FileOperation, type GitBatch, type GitRun } from './domain.js';
import { type SshTransport } from '../core/ssh.js';
import { type TuiUsageEntry } from './tui-usage.js';
export declare class WorkspaceFiles {
    private readonly transport;
    constructor(transport: SshTransport);
    nativeSharing(request: Record<string, unknown>): Promise<any>;
    /** The records that can title a Claude Code session, from its file on this machine if it has saved that session. */
    /** Ends a terminal's holder and what runs in it, if there is one. */
    endHolder(holder: string): Promise<void>;
    claudeTitleRecords(claudeSession: string): Promise<string>;
    /** The records that can title a Codex thread: its newest line of Codex's name index and its first user messages. */
    codexTitleRecords(thread: string): Promise<string>;
    /**
     * What TUI conversations' CLIs logged since the last read, for their token usage: each file's new whole lines that can
     * hold usage, under a header `@ <entry> <from> <end> <capped> <file>` giving the bytes read. Claude Code's lines lose the
     * message text and its copy of tool inputs, as only the usage is wanted; a long session's log runs to megabytes.
     * See tui-usage.ts.
     */
    tuiUsageLines(entries: readonly TuiUsageEntry[], signal?: AbortSignal, cap?: number): Promise<Buffer>;
    /**
     * Starts a Codex thread for `codex resume` to open, as Codex cannot be told the ID of a session it starts. App server
     * only saves the thread once it has a message or a name, and it needs no message from this connection for a name.
     * @returns the thread's ID.
     */
    codexThread(cwd: string, name: string, signal: AbortSignal): Promise<string>;
    /** Runs one shell operation and returns its data; the program reports handled failures with their status. */
    private run;
    /** Remote DSH runs on Node.js, so only its own operations need it on the host. */
    private remoteDsh;
    operate(cwd: string, operation: FileOperation, signal?: AbortSignal): Promise<unknown>;
    download(cwd: string, path: string, revision: string, signal?: AbortSignal): Promise<Buffer>;
    /** A file by absolute path, read from its own directory, or undefined when it is larger than `limit` bytes. */
    readAbsolute(path: string, limit: number, signal?: AbortSignal): Promise<Buffer | undefined>;
    upload(cwd: string, path: string, revision: string | null, size: number, input: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<unknown>;
    /**
     * A file kept for a conversation rather than part of the project: private, atomic and checked against its digest.
     * @param path - relative to `cwd`, under `.dsh-remote-agents/attachments/`.
     * @returns the file's absolute path.
     */
    attach(cwd: string, path: string, input: AsyncIterable<Uint8Array>, size: number, sha256: string, signal?: AbortSignal): Promise<string>;
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
