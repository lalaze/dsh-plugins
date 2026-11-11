import { type GoalIdentity } from '../chat/claude-goal.js';
import { type Agent, type FinishedTurn, type TurnUsage, type NativeAttachment, type NativeProtocol, type PermissionAnswer, type Task } from '../core/domain.js';
import { JsonlPeer } from '../core/ssh.js';
import { type RelayLink } from './relay.js';
import { TaskHistory } from './history.js';
import type { Store } from '../core/store.js';
export declare function initializeAcp(peer: JsonlPeer): Promise<any>;
export interface SessionHooks {
    /** Revoke the exact goal grant before surfacing a native session failure. */
    goalFailed?(messageId: string, reason: string): void;
    /** The CLI started a turn itself rather than for a message (see `continueUnprompted`). */
    ownTurnStarted?(): void;
    /** A turn ended; `unprompted` when the CLI started it itself rather than for a message (see `continueUnprompted`). */
    turnEnded?(turn: {
        unprompted: boolean;
    }): void;
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
    private goalIdentity?;
    private goalOrigins?;
    private claudeInputUuid?;
    private claudeUuidSupported;
    private claudeLegacy;
    private confirmed;
    private partialText;
    /** The model Claude's main thread answered with this turn: aliases such as `opus` resolve to a full model ID. */
    private turnModel?;
    /** Codex's running thread totals, as last reported. */
    private codexTotal;
    /**
     * Where the open Codex turn began in those totals; unset until known. A session that attaches after the turn began, as
     * after DSH restarts, does not know the thread's totals then, and must not count the whole thread as this turn.
     */
    private codexStart?;
    private suspended;
    private intentionalClose;
    private diskFailed;
    private admitting;
    private stopping;
    private released;
    private endedSent;
    private restoring;
    private imageInput;
    /** Background tasks Claude reported finished while idle; they head the turn it starts for them. */
    private notices;
    /** Items produced by the output line being processed, saved together with its relay offset. */
    private batch?;
    /** Images in that line's tool results, saved before its items so a chat reading them finds the files. */
    private viewed?;
    private permissions;
    private tools;
    private stopWaiters;
    constructor(peer: JsonlPeer, task: Task, history: TaskHistory, store: Store, hooks?: SessionHooks, relay?: RelayLink | undefined);
    get alive(): boolean;
    /** Disconnected on purpose, leaving the CLI running for DSH to reattach later or for another DSH. */
    get detached(): boolean;
    /** A turn, approval or message admission is in progress. */
    get busy(): boolean;
    /** Only sessions that can be resumed later may be closed to free a connection slot. */
    get evictable(): boolean;
    private append;
    private diskFailure;
    private position;
    /** Process one output line; its history items are saved in one write with the offset after it. */
    private frame;
    /**
     * Queue an image's base64 bytes to be saved with this output line, and return its copy's name; undefined when the chat
     * cannot show it. The bytes stay out of the history, which other DSHs copy: it records only the name.
     */
    private keepImage;
    /**
     * The images in a tool's output, as Claude (`source`) or MCP (`data`, `mimeType`) image blocks, such as a screenshot
     * it read. `path` is the remote file the tool read, when it names one, for a DSH without the copy.
     */
    private toolImages;
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
    }[], goalIdentity?: GoalIdentity): Promise<void>;
    private openGoalOrigins;
    /**
     * Reattach to a relay that kept running: rebuild the open turn, its tools and its unanswered
     * permission requests from the history, then resend saved answers (the relay drops duplicates).
     */
    restore(): Promise<void>;
    private protocol;
    /** `sentBy` names this DSH in a shared history, so the others can tell where the message came from. */
    send(text: string, messageId: string, attachments?: readonly NativeAttachment[], sentBy?: {
        instance: string;
        label: string;
    }): Promise<void>;
    private confirm;
    private complete;
    /**
     * Claude goes on without a message from DSH when a background task it ran finishes, or at a wake-up it scheduled.
     * Its output would otherwise land after the previous turn's end, unseen, with the session reading as idle. Such
     * output opens a turn of the CLI's own, headed by the task notices it got, saved and shown like any other turn.
     * Only Claude's own output counts: a subagent it left running in the background may still stream while it is idle.
     */
    private continueUnprompted;
    private setContext;
    /** Record what a turn used before it ends, so readers of the turn see it ahead of its end. */
    private turnUsage;
    private setTokenUsage;
    /** Keep where a Codex turn began, saved so that a DSH reattaching during the turn counts all of it. */
    private startCodexTurn;
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
    /**
     * An interrupted Codex turn leaves its commands running, so Stop ends them too. Only the ones this turn started:
     * what an earlier turn left running, such as a dev server, stays.
     */
    private endCommands;
    /** End the CLI process and the turn. */
    close(): void;
    private ended;
    /** Disconnect without affecting the CLI: a persistent session continues and is restored later. */
    release(): void;
}
