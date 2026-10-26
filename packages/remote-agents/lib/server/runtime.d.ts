import { type Agent, type NativeAttachment, type NativeProtocol, type PermissionAnswer, type Task } from './domain.js';
import { JsonlPeer } from './ssh.js';
import { TaskHistory } from './history.js';
import type { Store } from './store.js';
export declare function initializeCodex(peer: JsonlPeer): Promise<void>;
export declare function initializeAcp(peer: JsonlPeer): Promise<any>;
export declare class CliSession {
    readonly peer: JsonlPeer;
    readonly task: Task;
    readonly history: TaskHistory;
    private readonly store;
    readonly agent: Agent;
    private nativeId;
    private activeMessage?;
    private confirmed;
    private partialText;
    private suspended;
    private intentionalClose;
    private diskFailed;
    private admitting;
    private interrupting;
    private stopping;
    private imageInput;
    private permissions;
    private tools;
    private stopWaiters;
    constructor(peer: JsonlPeer, task: Task, history: TaskHistory, store: Store);
    get alive(): boolean;
    /** A turn, approval or message admission is in progress. */
    get busy(): boolean;
    /** Only sessions that can be resumed later may be closed to free a connection slot. */
    get evictable(): boolean;
    private append;
    initialize(protocol: NativeProtocol, argv: string[], resume?: boolean): Promise<void>;
    private protocol;
    send(text: string, messageId: string, attachments?: readonly NativeAttachment[]): Promise<void>;
    private confirm;
    private complete;
    private fail;
    private tool;
    private permission;
    respond(id: string, answer: PermissionAnswer): Promise<void>;
    private message;
    private request;
    private claudeRequest;
    stop(): Promise<void>;
    close(): void;
}
