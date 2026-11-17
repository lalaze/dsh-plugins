import { type Aspect, type BatchStatus, type GeneratedImage } from './domain.js';
import { type H3Options } from './h3.js';
export declare const H3_KEEP_MS: number;
export interface H3BatchOptions extends H3Options {
    /** How long finished results stay on disk before automatic cleanup (default 1 hour). */
    keepMs?: number;
}
export interface BatchRequestItem {
    path: string;
    aspect: Aspect;
    transparent: boolean;
}
export declare class H3Batches {
    private readonly options;
    private readonly jobs;
    private active;
    private starting;
    private disposed;
    constructor(options?: H3BatchOptions);
    private view;
    /** Returns this session's currently running job when there is one. */
    runningFor(sessionId: string): BatchStatus | undefined;
    /** Whether another session is currently booting, running or starting an h3 batch. */
    busyFor(sessionId: string): boolean;
    /** Returns the session's current or most recent job, or null when there is none (or `id` no longer matches). */
    status(sessionId: string, id?: string): BatchStatus | null;
    /**
     * Starts a batch redraw in the background and returns its initial status at once.
     * Reconnects to the running job when the same session calls again, and refuses with 409 when another session is active
     * or when `h3 status` reports a VM already running.
     */
    start(sessionId: string, prompt: string, items: readonly BatchRequestItem[], readRef: (path: string) => Promise<Buffer>): Promise<BatchStatus>;
    private runJob;
    /** Reads one finished picture of a batch from the temporary directory on demand. */
    result(sessionId: string, id: string, index: number): Promise<GeneratedImage>;
    /** Stops the running job for `sessionId`, waits for `h3 down` to finish, and keeps any completed pictures for review. */
    stop(sessionId: string, id?: string): Promise<BatchStatus>;
    /** Discards a job (stopping it first if still running) and deletes its temporary directory. */
    discard(sessionId: string, id?: string): Promise<void>;
    private removeJob;
    /** Stops any running batch, waits for `h3 down`, and removes all temporary directories. */
    dispose(): Promise<void>;
}
