import type { WorkspaceHosts } from './hosts.js';
import { type WorkspacePlacement } from './access.js';
import { type FileOperation, type GitBatch, type GitRun, type SyncResult, type WorkspaceTarget } from './domain.js';
export type SessionPlacement = (id: string, signal: AbortSignal) => Promise<WorkspacePlacement>;
export declare const hash: (data: Uint8Array | string) => string;
/** A path exactly as given: names may begin or end with spaces, so trimming would address a different file. */
export declare function workspacePath(value: unknown, label: string): string;
export declare function fileOperation(raw: unknown): FileOperation;
export declare function revision(value: unknown): string | null;
/** All entry points derive host and cwd from the DSH session; callers can only assert an expected target. */
export declare class WorkspaceService {
    readonly machines: WorkspaceHosts;
    readonly placement: SessionPlacement;
    private readonly localCwd;
    private readonly syncing;
    /** Only this session's active request can cancel its pinned target, even after the session changes workspace. */
    private readonly gitJobs;
    constructor(machines: WorkspaceHosts, placement: SessionPlacement, localCwd: (id: string) => Promise<string | undefined>);
    target(sessionId: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<WorkspaceTarget>;
    operate(sessionId: string, raw: unknown, signal: AbortSignal, expected?: WorkspaceTarget): Promise<unknown>;
    download(sessionId: string, path: string, rev: string, signal: AbortSignal, expected?: WorkspaceTarget): Promise<Buffer>;
    /**
     * A file a remote CLI of this conversation named by absolute path, such as an image Codex viewed, read on the
     * conversation's verified machine. It may be outside the workspace: the CLI there already read it.
     */
    readViewed(sessionId: string, path: string, limit: number, signal: AbortSignal): Promise<Buffer | undefined>;
    /** Ends a terminal the user closed, which otherwise keeps running on the conversation's machine. */
    endHolder(sessionId: string, holder: string, signal: AbortSignal): Promise<void>;
    /** The title records of a Claude Code session on the conversation's verified machine. */
    claudeTitleRecords(sessionId: string, claudeSession: string, signal: AbortSignal): Promise<string>;
    /** A new Codex thread in the conversation's verified remote directory. */
    codexThread(sessionId: string, name: string, signal: AbortSignal): Promise<string>;
    /** The title records of a Codex thread on the conversation's verified machine. */
    codexTitleRecords(sessionId: string, thread: string, signal: AbortSignal): Promise<string>;
    upload(sessionId: string, path: string, rev: string | null, size: number, input: AsyncIterable<Uint8Array>, signal: AbortSignal, expected?: WorkspaceTarget): Promise<unknown>;
    /** A file kept for this conversation on its verified machine; see WorkspaceFiles.attach. */
    attach(sessionId: string, path: string, input: AsyncIterable<Uint8Array>, size: number, sha256: string, signal: AbortSignal): Promise<string>;
    /** Git commands in the conversation's verified remote directory, for other plugins; never offered to models. */
    git(sessionId: string, batch: GitBatch, signal: AbortSignal, expected?: WorkspaceTarget): Promise<GitRun[]>;
    cancelGit(sessionId: string, id: string, signal: AbortSignal, expected?: WorkspaceTarget): Promise<void>;
    sync(sessionId: string, direction: 'pull' | 'push', dryRun: boolean, signal: AbortSignal, expected?: WorkspaceTarget, planId?: string): Promise<SyncResult>;
}
