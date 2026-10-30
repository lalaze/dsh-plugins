import { type Branch, type Comparison, type CredentialTarget, type Done, type Location, type Overview, type Status, type Summary } from './domain.js';
import { type WorkspaceFiles } from './files.js';
import { type GitRunner, type RemoteWorkspaces } from './runner.js';
interface Workspace {
    location: Location;
    runner: GitRunner;
    files: WorkspaceFiles;
    local: boolean;
}
export interface GitViewOptions {
    /** A conversation's working directory. */
    cwdOf(sessionId: string): Promise<string | undefined>;
    local(cwd: string): GitRunner;
    /** Production uses this DSH home's exact anchor root; tests may supply synthetic anchors. */
    isRemoteCwd?(cwd: string): boolean;
    /** Remote Agents' service, when that plugin is installed. */
    remote(): RemoteWorkspaces | undefined;
    credentials?: {
        config(): Promise<string[]>;
        save(host: unknown, username: unknown, password: unknown): Promise<void>;
    };
}
/** Text the user named: a branch, ref or message; never empty, never read as an option, without control characters. */
export declare function argument(value: unknown, label: string, max?: number): string;
/** Git for DSH conversations: on this machine, or in a verified Remote Agents remote workspace. */
export declare class GitView {
    private readonly options;
    private readonly running;
    constructor(options: GitViewOptions);
    /** A remote workspace folder runs Git on its machine; one that cannot be verified never falls back to this machine. */
    workspace(sessionId: string, signal: AbortSignal, expectedCwd?: unknown): Promise<Workspace>;
    private run;
    /** Register before workspace discovery so early cancellation cannot be lost; retain it between Git batches. */
    private operation;
    /** Stops a running request of this DSH, wherever its Git runs. */
    cancel(id: unknown): Promise<void>;
    /** The current branch, for the composer's branch button. */
    summary(sessionId: string, signal: AbortSignal): Promise<Summary>;
    /** Local and remote branches, for the composer's branch list. */
    branches(sessionId: string, signal: AbortSignal): Promise<Summary & {
        local: Branch[];
        remote: Branch[];
    }>;
    /** Everything the Git view shows, in one round trip. */
    overview(sessionId: string, signal: AbortSignal): Promise<Overview>;
    /** Changed files, for the change marks and the change list. */
    status(sessionId: string, signal: AbortSignal): Promise<Status>;
    /** An inline diff: the index against HEAD for staged rows, otherwise all working-tree changes against HEAD. */
    diff(sessionId: string, path: unknown, signal: AbortSignal, staged?: boolean): Promise<Done>;
    /** A workspace file at HEAD and as it is now; `path` is relative to the workspace folder. */
    compare(sessionId: string, path: unknown, signal: AbortSignal, expectedCwd?: unknown): Promise<Comparison>;
    save(sessionId: string, path: unknown, content: unknown, revision: unknown, signal: AbortSignal, expectedCwd?: unknown): Promise<{
        revision: string;
    }>;
    /** Save a reviewed conflict resolution, then stage that same verified workspace file. Never auto-commit a merge. */
    saveResolve(sessionId: string, path: unknown, content: unknown, revision: unknown, id: unknown, signal: AbortSignal, expectedCwd?: unknown): Promise<{
        revision: string;
        staged: boolean;
        output?: string;
        error?: string;
    }>;
    /** One change; `id` lets the user cancel it. */
    private change;
    /** A local branch, or a remote branch as a new local branch tracking it. */
    switchBranch(s: string, branch: unknown, remote: boolean, id: unknown, signal: AbortSignal): Promise<Done>;
    pull(s: string, id: unknown, signal: AbortSignal): Promise<Done>;
    fetch(s: string, id: unknown, signal: AbortSignal): Promise<Done>;
    push(s: string, id: unknown, signal: AbortSignal): Promise<Done>;
    /** Fetch current tracking information, integrate only when behind without rewriting commits, then push. */
    sync(s: string, id: unknown, signal: AbortSignal): Promise<Done>;
    rename(s: string, branch: unknown, to: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    deleteBranch(s: string, branch: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    /** `origin/topic` deletes `topic` on `origin`. */
    deleteRemoteBranch(s: string, branch: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    merge(s: string, branch: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    /** Stages everything and commits it. */
    commit(s: string, text: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    stashPush(s: string, text: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    stashPop(s: string, id: unknown, signal: AbortSignal): Promise<Done>;
    stage(s: string, path: unknown, id: unknown, signal: AbortSignal, expectedCwd?: unknown): Promise<Done>;
    unstage(s: string, path: unknown, id: unknown, signal: AbortSignal, from?: unknown): Promise<Done>;
    /** Unstaged changes go back to the index; an untracked file is removed. */
    discard(s: string, path: unknown, untracked: boolean, id: unknown, signal: AbortSignal): Promise<Done>;
    cherryPick(s: string, commit: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    revert(s: string, commit: unknown, id: unknown, signal: AbortSignal): Promise<Done>;
    /** The HTTPS host of the remote that pull and push use, for saving a credential. */
    credentialTarget(sessionId: string, signal: AbortSignal): Promise<CredentialTarget>;
    /** Only for local workspaces: a remote machine keeps its own credential helpers and SSH keys. */
    saveCredential(sessionId: string, host: unknown, username: unknown, password: unknown, signal: AbortSignal): Promise<void>;
}
export {};
