import type { RemoteAgentsMachines } from './core/machines.js';
import { type GitResult, type GitStep, type WorktreeMachine } from './worktree-machine.js';
/**
 * Workspaces that start from a project: a Git worktree on the project's machine, adopted as a DSH workspace of its own.
 * Worktrees live outside the repository, under `~/.dsh/worktrees` on this computer and `~/.dsh-remote-agents/worktrees`
 * on a saved SSH machine, one folder per repository; a path there is how this plugin knows a worktree is its own. A
 * repository's `.dsh/worktree.json` lists commands that set a new worktree up and tear it down before it is removed.
 */
/** The project setup file, relative to a checkout. */
export declare const WORKTREE_CONFIG = ".dsh/worktree.json";
export type WorktreeLocation = {
    kind: 'local';
} | {
    kind: 'remote';
    hostId: string;
    host: string;
};
/** A DSH workspace one can start a worktree from, one per repository: `folder` is the project folder on its machine. */
export interface WorktreeProject {
    path: string;
    title: string;
    location: WorktreeLocation;
    folder: string;
    home?: string;
}
export interface WorktreeBranch {
    name: string;
    /** Present as a local branch. */
    local: boolean;
    /** The remote-tracking branch, as `origin/main`. */
    remote?: string;
    /** Commits the local branch has that its upstream lacks, and the reverse. */
    ahead?: number;
    behind?: number;
    /** Last commit time, in seconds. */
    date: number;
    /** The checkout that has this branch, when one does. */
    checkedOutAt?: string;
}
/** A worktree this plugin created for the project, and the DSH workspace that stands for it. */
export interface ManagedWorktree {
    path: string;
    branch: string | null;
    workspace?: {
        workspaceId: string;
        title: string;
        path: string;
    };
}
export interface WorktreeProjectDetail {
    path: string;
    location: WorktreeLocation;
    /** The machine's home folder, for showing paths as `~/…`. */
    home: string;
    /** Repository name, the main checkout, and the workspace folder inside a checkout ('' at its top). */
    name: string;
    repository: string;
    subdir: string;
    head: string | null;
    defaultBase: string | null;
    branches: WorktreeBranch[];
    /** Where a new worktree goes: the repository's folder of worktrees. */
    root: string;
    setup: string[];
    worktrees: ManagedWorktree[];
}
export interface ArchiveCheck {
    branch: string | null;
    /** Changed and untracked files. */
    dirty: number;
    /** Commits on no remote branch; null when the repository has no remote to compare with. */
    unpushed: number | null;
    /** The branch the worktree's branch is merged into, when it is. */
    mergedInto: string | null;
    teardown: string[];
    workspaces: {
        workspaceId: string;
        title: string;
        sessions: number;
    }[];
}
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type JobAction = 'cancel' | 'retry' | 'skip' | 'discard' | 'confirm';
/** A message for the client to translate: an English key with `{name}` values, and Git's own words when there are any. */
export interface JobMessage {
    key: string;
    values?: Record<string, string>;
    detail?: string;
}
export interface WorktreeJob {
    id: string;
    kind: 'create' | 'archive';
    state: 'running' | 'failed' | 'done' | 'discarded';
    steps: {
        id: string;
        state: StepState;
        detail?: string;
    }[];
    log: string;
    error?: JobMessage;
    actions: JobAction[];
    result?: {
        path?: string;
        title?: string;
        branch: string | null;
        worktree: string;
        warnings: JobMessage[];
    };
}
export interface CreateRequest {
    path: string;
    mode: 'new' | 'existing';
    base?: string;
    branch?: string;
    /** The setup commands the form showed. It reads the project's checkout, so a branch's own wait for a confirmation. */
    setup?: readonly string[];
}
export interface ArchiveRequest {
    path: string;
    worktree: string;
    deleteBranch?: boolean;
}
/**
 * The folder a DSH workspace stands for, on its machine, for another plugin to work in: Git, shell commands and text
 * files there. Commands run in that folder; `read` takes a path inside it.
 */
export interface WorkspaceMachine {
    location: WorktreeLocation;
    folder: string;
    git(steps: GitStep[], options?: {
        reads?: boolean;
        signal?: AbortSignal;
    }): Promise<GitResult[]>;
    /** A shell command for as long as it takes; both output streams go to `output`. Resolves the exit code, null when stopped. */
    shell(command: string, env: Record<string, string>, output: (text: string) => void, signal: AbortSignal): Promise<number | null>;
    /** A text file, or undefined when it is missing or larger than `limit` bytes. */
    read(file: string, limit: number, signal?: AbortSignal): Promise<string | undefined>;
}
/** DSH's host workspace registry, as far as worktree workspaces use it. */
export interface DshWorkspace {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: readonly string[];
}
export interface DshWorkspaceController {
    create(request: {
        path: string;
    }): Promise<{
        workspace: DshWorkspace;
        created: boolean;
    }>;
    rename(request: {
        workspaceId: string;
        title: string;
    }): Promise<unknown>;
    delete(request: {
        workspaceId: string;
    }): Promise<unknown>;
    insertBefore(request: {
        workspaceId: string;
        beforeWorkspaceId?: string;
    }): Promise<unknown>;
    archiveSession(request: {
        sessionId: string;
        stopActivity?: boolean;
    }): Promise<unknown>;
    follow(signal: AbortSignal): AsyncIterable<{
        type: string;
        value?: {
            items?: readonly DshWorkspace[];
        };
    }>;
}
/** The part of dsh-workspace-tags' service a new workspace takes its tags through. */
export interface WorkspaceTags {
    snapshot(): TagAssignments;
    replace(state: TagAssignments): Promise<unknown>;
}
interface TagAssignments {
    assignments: Record<string, string[]>;
    [other: string]: unknown;
}
export interface WorktreeHost {
    machines: Pick<RemoteAgentsMachines, 'hosts' | 'browse' | 'withWorkspace'>;
    access: {
        resolve: RemoteAgentsMachines['resolve'];
    };
    anchors: {
        create: RemoteAgentsMachines['createWorkspace'];
    };
    dsh(): DshWorkspaceController | undefined;
    tags?(): WorkspaceTags | undefined;
    /** Stops and archives remote CLI sessions working in a folder on a machine. */
    stopRemoteSessions?(hostId: string, folder: string): Promise<void>;
    /** DSH's home folder; holds this computer's worktrees and the remote workspace anchors. */
    home?: string;
    local?: WorktreeMachine;
    remote?(hostId: string): WorktreeMachine;
}
/** Usable as a folder name on every system: letters, digits, dot, dash and underscore. */
export declare function slugify(value: string): string;
/** A branch name such as `swift-otter`, for a new branch nobody named. */
export declare const friendlyName: () => string;
/** `git for-each-ref` records: refname, commit time, upstream, upstream tracking, separated by NUL. */
export declare const BRANCH_FORMAT = "%(refname)%00%(committerdate:unix)%00%(upstream)%00%(upstream:track,nobracket)";
/** Local and remote-tracking branches, one entry per name, most recently committed first. */
export declare function parseBranches(output: string, remotes: readonly string[], checkouts?: ReadonlyMap<string, string>): WorktreeBranch[];
export interface WorktreeRecord {
    path: string;
    branch: string | null;
    head?: string;
    bare?: boolean;
}
/** `git worktree list --porcelain` output. */
export declare function parseWorktrees(output: string): WorktreeRecord[];
/** The setup file's commands: `{ "setup": [...], "teardown": [...] }`. */
export declare function parseConfig(text: string | undefined): {
    setup: string[];
    teardown: string[];
};
export declare class WorktreeService {
    private readonly host;
    private readonly jobs;
    private readonly created;
    private readonly busy;
    private readonly local;
    private readonly remotes;
    constructor(host: WorktreeHost);
    /** Stops running operations, as when the plugin unloads. */
    close(): void;
    private get home();
    private remote;
    private anchored;
    /** The machine and folder a DSH workspace stands for. */
    private place;
    /** Only a folder DSH lists as a workspace: a plugin works where the user's conversations do, not anywhere on a machine. */
    machine(path: string, signal?: AbortSignal): Promise<WorkspaceMachine>;
    /** The folder holding a machine's worktrees. */
    private machineRoot;
    /** Whether a folder is a worktree this plugin made: two levels under the machine's worktree folder. */
    private managedRoot;
    private repository;
    /** DSH's workspaces, as its registry lists them now. */
    private workspaces;
    /** The DSH workspaces inside a worktree on a machine. */
    private workspacesIn;
    private config;
    /** DSH workspaces that are Git projects on this computer, and those on saved machines, which are checked when chosen. */
    projects(signal?: AbortSignal): Promise<WorktreeProject[]>;
    inspect(path: string, signal?: AbortSignal): Promise<WorktreeProjectDetail>;
    job(id: string): WorktreeJob;
    private start;
    private drive;
    act(id: string, action: JobAction): Promise<WorktreeJob>;
    /** Create a worktree from a project and adopt it as a DSH workspace; setup commands run last. */
    create(request: CreateRequest): WorktreeJob;
    /** Adopt the worktree as a DSH workspace, then run the setup commands not run yet. */
    private finish;
    /** Add a folder to DSH under `title`, next to the workspace it started from and with that workspace's tags. */
    private register;
    /** Removes what a create job made: its DSH workspace, the worktree and a branch it created. */
    private discard;
    private removeWorktree;
    private unregister;
    /** What archiving a worktree would lose, for the confirmation. */
    archiveCheck(path: string, worktree: string, signal?: AbortSignal): Promise<ArchiveCheck>;
    /** A worktree of this project that this plugin made, still known to Git or left behind as a folder. */
    private owned;
    private mergedInto;
    /** Stop the worktree's sessions, run its teardown, remove it, optionally delete its merged branch, and remove its workspaces from DSH. */
    archive(request: ArchiveRequest): WorktreeJob;
}
export {};
