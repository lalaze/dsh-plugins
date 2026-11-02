/** A push-to-pull bridge: producers push values, one consumer iterates them in order until closed. */
export class AsyncQueue {
    buffer = [];
    waiter;
    closed = false;
    failure;
    push(value) {
        if (this.closed)
            return;
        this.buffer.push(value);
        this.waiter?.();
    }
    close(error) {
        if (this.closed)
            return;
        this.closed = true;
        this.failure = error;
        this.waiter?.();
    }
    get isClosed() { return this.closed; }
    async *[Symbol.asyncIterator]() {
        while (true) {
            while (this.buffer.length > 0)
                yield this.buffer.shift();
            if (this.closed) {
                if (this.failure)
                    throw this.failure;
                return;
            }
            await new Promise(resolve => { this.waiter = resolve; });
            this.waiter = undefined;
        }
    }
}
/** Resolve after `ms`, or early when `signal` aborts. */
export const sleep = (ms, signal) => new Promise(resolve => {
    if (signal?.aborted)
        return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
});
