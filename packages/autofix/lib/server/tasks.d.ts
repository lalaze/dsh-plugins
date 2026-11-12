/**
 * One bug from start to done. The models only change files: this code decides when they run, checks what they left,
 * commits it, and pushes nothing until a person accepts.
 */
import type { Conversations } from './conversations.js';
import { type Item, type ItemImage, type Source, type Task } from './domain.js';
import type { Store } from './store.js';
import type { Workplaces } from './workplaces.js';
export interface TaskHost {
    store: Store;
    /** The source an item came from, while its plugin is loaded. */
    source(id: string): Source | undefined;
    workplaces: Pick<Workplaces, 'create' | 'machine' | 'remove'>;
    conversations: Pick<Conversations, 'open' | 'flow' | 'picture'>;
    now?(): number;
    /** After every saved change, for whoever is showing the tasks. */
    changed?(): void;
    /** Puts a card for the task into its conversation: it now waits for a person, or has failed. `task.cards` is that card's number. */
    announce?(task: Task): Promise<void>;
}
export declare class Tasks {
    private readonly host;
    private readonly live;
    constructor(host: TaskHost);
    private now;
    private note;
    private save;
    private move;
    /** A card in the task's own conversation, where the person reads the work and decides. Without one the board still shows the task. */
    private announce;
    private route;
    private task;
    running(key: string): boolean;
    /** Resolves when the task's current run has ended, however it ended. */
    idle(key: string): Promise<void>;
    /** Runs in the background; a failure lands on the task instead of the caller. */
    private drive;
    /** Tells the item's source what happened. Whatever it answers, what already happened in Git stands. */
    private report;
    /** The tracker's name for the models; a bug a person typed in has none. */
    private sourceName;
    /**
     * Starts the bug as its pool entry says: repository, branch, and the package if one was chosen. `pictures` are ones DSH
     * already keeps (sent along in a conversation), in the order the bug's text names them.
     */
    start(key: string, pictures?: readonly unknown[]): Promise<Task>;
    private prepare;
    /** The bug's pictures, from its source into DSH's attachment store, so every step of every flow can be given them. */
    private pictures;
    /** Flow, checks, commit; a failed check goes back to the models as long as retries are left. */
    private work;
    /** Stages everything, refuses what must never be committed, then runs the repository's checks. Returns what failed. */
    private check;
    /** Ends whatever the task is doing. False when it was doing nothing. */
    stop(key: string): boolean;
    /**
     * Back to the models in the same worktree and conversation, with what the person said and the pictures they added.
     * `kept` are pictures DSH already keeps, as when they came with a line typed in the conversation.
     */
    sendBack(key: string, feedback: string, pictures?: readonly ItemImage[], kept?: readonly unknown[]): Promise<Task>;
    /** The fix goes where the repository's setting says, then its source is told. */
    accept(key: string): Promise<Task>;
    /**
     * A merge commit made from the two trees and pushed, without touching the worktree: nothing to abort when it conflicts,
     * and files a build left behind cannot get in the way.
     */
    private merge;
    /** Tells the source again what it could not be told when the fix was accepted. */
    retryReport(key: string): Promise<Task>;
    /**
     * A finished fix's worktree, with its workspace and conversation in DSH, taken away once a person says so. The task
     * stays on the board. Its branch goes too when the fix was merged; a branch that was only pushed is kept.
     */
    removeWorkspace(key: string): Promise<Task>;
    /** The fix's branch, once everything on it is in the base branch on the remote. */
    private dropBranch;
    /** Forgets a task that is not running. Its worktree and conversation stay in DSH. */
    forget(key: string): Promise<void>;
    /** Stops everything, as when the plugin unloads. */
    close(): void;
}
export type { Item };
