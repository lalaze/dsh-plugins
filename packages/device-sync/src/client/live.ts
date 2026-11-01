import type { LiveFrame } from '../shared/protocol.js'

/** Decode NDJSON, including an unterminated final frame; abort cancels a pending read. */
export async function readLiveFrames(body: ReadableStream<Uint8Array>, signal: AbortSignal, onFrame: (frame: LiveFrame) => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder()
  let buffer = '', ended = false
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const emit = (line: string) => { if (line.trim() && !signal.aborted) onFrame(JSON.parse(line) as LiveFrame) }
  try {
    if (signal.aborted) return
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (signal.aborted) return
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); emit(line) }
      if (done) { ended = true; emit(buffer); return }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!ended) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function retryLiveError(error: unknown): boolean {
  const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
  return typeof status !== 'number' || status < 400 || status >= 500 || status === 408 || status === 429
}

/** Serial reconnects: no overlapping streams or timers, and abort disposes the pending delay. */
export async function reconnectLive(signal: AbortSignal, connect: () => Promise<void>, failed: (error: unknown, retrying: boolean) => void, delayMs = 3000): Promise<void> {
  while (!signal.aborted) {
    let failure: unknown
    try { await connect(); failure = new Error('Live connection closed.') } catch (e) { failure = e }
    if (signal.aborted) return
    const retrying = retryLiveError(failure)
    failed(failure, retrying)
    if (!retrying || signal.aborted) return
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, delayMs)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }
}
