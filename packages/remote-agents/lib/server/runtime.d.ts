import { type Agent, type FinishedTurn, type TurnUsage, type NativeAttachment, type NativeProtocol, type PermissionAnswer, type Task } from './domain.js';
import { JsonlPeer } from './ssh.js';
import { type RelayLink } from './relay.js';
import { TaskHistory } from './history.js';
import type { Store } from './store.js';
export declare function initializeCodex(peer: JsonlPeer): Promise<void>;
export declare function initializeAcp(peer: JsonlPeer): Promise<any>;
export interface SessionHooks {
    turnEnded?(): void;
    /** Tokens a finished turn used, with when it started, whether it succeeded and the model that ran. */
    usage?(usage: TurnUsage, turn: FinishedTurn): void;
    /** The CLI process ended or was terminated; a relay's remote files can be removed. */
    ended?(): void;
}
export declare class CliSession {
    readonly peer: JsonlPeer;
    readonly task: Task;
    readonly history: TaskHistory;
    private readonly store;
    private readonly hooks;
    readonly relay?: RelayLink | undefined;
    readonly agent: Agent;
    /** Claude's signed-in account from `initialize`, used to label its plan limits. */
    account?: unknown;
    private nativeId;
    private savedUsage;
    private activeMessage?;
    private confirmed;
    private partialText;
    /** The model Claude's main thread answered with this turn: aliases such as `opus` resolve to a full model ID. */
    private turnModel?;
    /** Codex running thread totals, now and when the current turn began. */
    private codexTotal;
    private codexBefore;
    private suspended;
    private intentionalClose;
    private diskFailed;
    private admitting;
    private interrupting;
    private stopping;
    private released;
    private endedSent;
    private restoring;
    private imageInput;
    /** Items produced by the output line being processed, saved together with its relay offset. */
    private batch?;
    private permissions;
    private tools;
    private stopWaiters;
    constructor(peer: JsonlPeer, task: Task, history: TaskHistory, store: Store, hooks?: SessionHooks, relay?: RelayLink | undefined);
    get alive(): boolean;
    /** A turn, approval or message admission is in progress. */
    get busy(): boolean;
    /** Only sessions that can be resumed later may be closed to free a connection slot. */
    get evictable(): boolean;
    private append;
    private diskFailure;
    private position;
    /** Process one output line; its history items are saved in one write with the offset after it. */
    private frame;
    private write;
    /** `mcpServers` are DSH's shared servers in ACP's stdio form; other protocols receive them as launch options. */
    initialize(protocol: NativeProtocol, argv: string[], resume?: boolean, mcpServers?: {
        name: string;
        command: string;
        args: string[];
        env: {
            name: string;
            value: string;
        }[];
    }[]): Promise<void>;
    /**
     * Reattach to a relay that kept running: rebuild the open turn, its tools and its unanswered
     * permission requests from the history, then resend saved answers (the relay drops duplicates).
     */
    restore(): Promise<void>;
    private protocol;
    send(text: string, messageId: string, attachments?: readonly NativeAttachment[]): Promise<void>;
    private confirm;
    private complete;
    private setContext;
    /** Record what a turn used before it ends, so readers of the turn see it ahead of its end. */
    private turnUsage;
    private setTokenUsage;
    /** Save request snapshots as they arrive, including during long tool loops and resume. */
    private saveUsage;
    /** Claude reports its exact context breakdown on request, including after compaction. */
    private claudeContext;
    private fail;
    private tool;
    private permission;
    respond(id: string, answer: PermissionAnswer): Promise<void>;
    private resolved;
    private message;
    /** Codex `turn/start` and ACP `session/prompt` responses for the active message. */
    private promptResponse;
    private request;
    private claudeRequest;
    stop(): Promise<void>;
    /** End the CLI process and the turn. */
    close(): void;
    private ended;
    /** Disconnect without affecting the CLI: a persistent session continues and is restored later. */
    release(): void;
}
