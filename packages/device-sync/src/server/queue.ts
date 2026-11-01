/** A push-to-pull bridge: producers push values, one consumer iterates them in order until closed. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private waiter?: () => void
  private closed = false
  private failure?: unknown

  push(value: T): void {
    if (this.closed) return
    this.buffer.push(value)
    this.waiter?.()
  }
  close(error?: unknown): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    this.waiter?.()
  }
  get isClosed(): boolean { return this.closed }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift()!
      if (this.closed) { if (this.failure) throw this.failure; return }
      await new Promise<void>(resolve => { this.waiter = resolve })
      this.waiter = undefined
    }
  }
}

/** Resolve after `ms`, or early when `signal` aborts. */
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve()
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
  signal?.addEventListener('abort', done, { once: true })
})
