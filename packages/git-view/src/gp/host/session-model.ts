/**
 * The model the next prompt of a session would use, read off the
 * `modelSelection` session projection (`next` = pending ?? lastUsed).
 *
 * Both services are looked up on every call: `sessionProjections` is not in
 * the plugin's `static inject`, so it may come up after activation or be
 * restarted while the plugin keeps running, and a reference taken once would
 * stay undefined (or point at the released instance) for good.
 */
import type { SessionModelSelection } from './llm-face.js'

/** Structural slice of the Cordis sessions store (live session objects). */
interface SessionsLookup {
  get(id: string): unknown
}

/** Structural slice of sessionProjections: read the modelSelection wire view. */
interface SessionProjectionsLike {
  snapshot(session: unknown, keys?: readonly string[]): {
    readonly values?: {
      readonly modelSelection?: {
        readonly next?: {
          readonly provider?: unknown
          readonly model?: unknown
          readonly reasoningEffort?: unknown
        } | null
      } | null
    }
  }
}

/**
 * @param get - the context's service lookup, called per request.
 * @returns a reader of a session's next model route; undefined when either
 *   service is missing, the session is unknown, the projection throws, or it
 *   names no complete provider/model pair.
 */
export function sessionModelReader(get: (key: string) => unknown): (sessionId: string) => SessionModelSelection | undefined {
  return (sessionId) => {
    const sessions = get('sessions') as SessionsLookup | undefined
    const projections = get('sessionProjections') as SessionProjectionsLike | undefined
    const session = sessions?.get(sessionId)
    if (session === undefined || projections === undefined) return undefined
    try {
      const next = projections.snapshot(session, ['modelSelection']).values?.modelSelection?.next
      if (next == null || typeof next.provider !== 'string' || typeof next.model !== 'string') return undefined
      if (next.provider === '' || next.model === '') return undefined
      return {
        provider: next.provider,
        model: next.model,
        ...(typeof next.reasoningEffort === 'string' && next.reasoningEffort !== ''
          ? { reasoningEffort: next.reasoningEffort }
          : {}),
      }
    } catch {
      return undefined
    }
  }
}
