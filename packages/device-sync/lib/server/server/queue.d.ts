/** A push-to-pull bridge: producers push values, one consumer iterates them in order until closed. */
export declare class AsyncQueue<T> implements AsyncIterable<T> {
    private readonly buffer;
    private waiter?;
    private closed;
    private failure?;
    push(value: T): void;
    close(error?: unknown): void;
    get isClosed(): boolean;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
/** Resolve after `ms`, or early when `signal` aborts. */
export declare const sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
