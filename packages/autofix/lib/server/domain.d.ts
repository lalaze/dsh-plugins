/** What the plugin keeps: settings, the bugs waiting to be handed out, and the tasks working on them. */
import type { FlowEnd, FlowRole, FlowStep, ModelChoice, Permission } from './conversations.js';
/**
 * A bug as any source hands it in. `source` and `id` name it for good; the rest is what a person and a model read.
 * `ref` is the short name people use for it (a TAPD bug number); `project` is where it lives in the source's own terms.
 */
export interface Item {
    source: string;
    id: string;
    ref: string;
    title: string;
    /** Plain text. Pictures the source could not put into words stand as `[image N]`. */
    body: string;
    url?: string;
    project?: {
        id: string;
        name: string;
    };
    status?: string;
    priority?: string;
    module?: string;
    labels: string[];
    /** How many pictures the bug has. The body may place them as `[image N]`; the source hands each over through `image`. */
    images?: number;
}
/** One picture of a bug, as the source read it. */
export interface ItemImage {
    data: Uint8Array;
    mediaType: string;
    name?: string;
}
export declare const itemKey: (item: {
    source: string;
    id: string;
}) => string;
/** What happened to an item, told to its source so it can write back to wherever the item came from. */
export type ItemEvent = {
    kind: 'started';
    baseBranch: string;
} | {
    kind: 'review';
    branch: string;
    commit: string;
    checks: number;
} | {
    kind: 'accepted';
    baseBranch: string;
    branch: string;
    commit: string;
    mergeCommit?: string;
};
/**
 * Where bugs come from: an issue tracker that is asked (`fetch`), or anything that hands bugs in when it has them
 * (`Autofix.submit`). A source registers with the service `autofix` and keeps its own sign-in and settings.
 */
export interface Source {
    /** Short and stable: part of every item's key, branch and commit message, as `tapd`. */
    id: string;
    /** What people call it. */
    name: string;
    /** Why it cannot be used yet, in words for a person; undefined when it is set up. */
    unready?(): Message | undefined;
    /** Everything open right now. An item it no longer lists is shown as no longer the person's. */
    fetch?(signal?: AbortSignal): Promise<Item[]>;
    /** A rejection is kept on the task and can be tried again; it never undoes what happened in Git. */
    report?(item: Item, event: ItemEvent): Promise<void>;
    /** Picture `index` (from 0) of an item, for the models to look at; undefined when it cannot be had. */
    image?(item: Item, index: number, signal?: AbortSignal): Promise<ItemImage | undefined>;
    /** The item is gone for good (fixed, or thrown away): whatever the source kept for it can go. */
    discard?(item: Item): Promise<void>;
}
/** The service `autofix`, for plugins that are sources. */
export interface Autofix {
    readonly version: 1;
    /** Returns how to take the source away again. Registering an ID again replaces the earlier one. */
    register(source: Source): () => void;
    /** For a source that is not asked: these bugs are open now. Known ones are refreshed; none is marked stale. */
    submit(sourceId: string, items: readonly Item[]): Promise<{
        added: number;
    }>;
}
export declare const SOURCE_ID: RegExp;
/** A repository bugs can be sent to. `project` is the DSH workspace that stands for it, on this computer or a saved machine. */
export interface Route {
    id: string;
    name: string;
    project: string;
    defaultBranch: string;
    /** Run after the models finish, before anything is committed. `{package}` and `{script}` stand for each package the fix touched. */
    tests: string[];
    packageGlobs: string[];
    /** Folders any fix may touch without counting as another package. */
    sharedPaths: string[];
    /** The first of these scripts a package has is its `{script}`. */
    buildScripts: string[];
    /** A command that serves the fix on `$PORT`; `{package}` as in `tests`. */
    preview: string;
    pushRemote: string;
    /** What accepting does: merge into the base branch and push it, or only push the task's branch. */
    accept: 'merge' | 'push-branch';
}
export interface RunSettings {
    /** Bugs carrying one of these labels are never started. */
    denyLabels: string[];
    /** The task conversation's own model; the flow's steps use the models chosen for /flow unless `flowModels` names others. */
    model?: ModelChoice;
    permission: Permission;
    rounds: number;
    flowModels: Partial<Record<FlowRole, string>>;
    /** How many times a failed check sends the work back to the models before the task fails. */
    checkRetries: number;
    /** Whether other DSHes may hand bugs to this one, through the machines that hold its repositories. */
    relay: boolean;
}
export interface Settings {
    routes: Route[];
    run: RunSettings;
}
export declare const SENSITIVE_LABELS: string[];
export declare const defaultSettings: () => Settings;
export interface Assignment {
    routeId: string;
    branch: string;
    package?: string;
}
export interface PoolItem {
    key: string;
    item: Item;
    firstSeen: number;
    lastSeen: number;
    /** No longer among the source's open bugs at its last fetch. */
    stale?: boolean;
    dismissed?: boolean;
    assignment?: Assignment;
}
/** Something to tell a person: English with `{name}` places, so a page can say it in its own language; `detail` is raw output. */
export interface Message {
    key: string;
    values?: Record<string, string>;
    detail?: string;
}
export declare const say: (key: string, values?: Record<string, string>, detail?: string) => Message;
export declare const render: (message: Message) => string;
/** An error that knows how to be said in another language. */
export declare class Failure extends Error {
    readonly said: Message;
    constructor(said: Message);
}
export declare const fail: (key: string, values?: Record<string, string>, detail?: string) => Failure;
export declare const messageOf: (error: unknown) => Message;
export type TaskStatus = 'preparing' | 'working' | 'checking' | 'review' | 'accepting' | 'done' | 'failed' | 'stopped';
export declare const ACTIVE: readonly TaskStatus[];
export interface CheckRun {
    command: string;
    code: number | null;
    ms: number;
    tail: string;
}
export interface TaskCheck {
    files: string[];
    /** Business packages the fix touched, as their folders. */
    packages: string[];
    /** Things to look at before accepting; none of them stopped the task. */
    warnings: Message[];
    runs: CheckRun[];
}
export interface TaskEvent {
    at: number;
    said: Message;
}
export interface Task {
    key: string;
    item: Item;
    routeId: string;
    baseBranch: string;
    packageHint?: string;
    status: TaskStatus;
    /** Flows run so far, the first included. */
    attempts: number;
    branch?: string;
    worktree?: string;
    workspacePath?: string;
    sessionId?: string;
    /** The bug's pictures the models are given, as DSH keeps them: `index` is the picture's place in the bug, from 0. */
    pictures?: {
        index: number;
        ref: unknown;
    }[];
    flow?: {
        steps: FlowStep[];
        end?: FlowEnd;
        report?: string;
    };
    check?: TaskCheck;
    commit?: string;
    mergeCommit?: string;
    error?: Message;
    /** What the person said when sending it back. */
    feedback?: string;
    /** How many cards the task has put into its conversation; only the newest one can be acted on. */
    cards?: number;
    /** What the source could not be told after the Git side succeeded; the task can tell it again. */
    reportPending?: ItemEvent;
    startedAt: number;
    updatedAt: number;
    events: TaskEvent[];
}
/** Settings as a person typed them, checked; throws what to fix. */
export declare function settingsFrom(raw: unknown): Settings;
/** An item as a source plugin handed it over, checked: another plugin's data is not trusted to have the right shape. */
export declare function itemFrom(raw: unknown, source: string): Item;
