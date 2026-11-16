import type { ServerResponse } from 'node:http';
import type { AttentionFrame, AttentionTracker } from './attention.js';
/** This machine's key on the board. */
export declare const SELF = "self";
export interface MachineAttention {
    /** The stream is up: `waiting` and `running` are current. */
    connected: boolean;
    waiting: AttentionFrame[];
    /** Finished or failed turns since the user last looked at the machine. */
    finished: AttentionFrame[];
    /** Sessions with a turn running. */
    running: string[];
}
export interface AttentionNotice {
    machine: string;
    frame: AttentionFrame;
}
export type AttentionState = Record<string, MachineAttention>;
export declare class AttentionBoard {
    private readonly machines;
    private readonly pages;
    private readonly feeds;
    private changed;
    private readonly keepAlive;
    private readonly unsubscribe;
    constructor(own: AttentionTracker);
    state(): AttentionState;
    /** Follow exactly these machines' streams: `{ id: listener url }`. */
    follow(targets: Record<string, string>): void;
    /** The user looked at a machine: its finished turns are no longer news. */
    seen(machine: string): void;
    /** A page's stream: the state now and after each change, and each frame that is news. */
    serve(res: ServerResponse): void;
    close(): void;
    private apply;
    private notice;
    private touch;
    /** One machine's stream, reconnecting with backoff until closed. */
    private subscribe;
}
/** This machine's own stream for other machines: a snapshot, then every frame, with keep-alives. */
export declare function serveEvents(tracker: AttentionTracker, res: ServerResponse): void;
