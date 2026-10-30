/**
 * The model the next prompt of a session would use, read off the
 * `modelSelection` session projection (`next` = pending ?? lastUsed).
 *
 * Both services are looked up on every call: `sessionProjections` is not in
 * the plugin's `static inject`, so it may come up after activation or be
 * restarted while the plugin keeps running, and a reference taken once would
 * stay undefined (or point at the released instance) for good.
 */
import type { SessionModelSelection } from './llm-face.js';
/**
 * @param get - the context's service lookup, called per request.
 * @returns a reader of a session's next model route; undefined when either
 *   service is missing, the session is unknown, the projection throws, or it
 *   names no complete provider/model pair.
 */
export declare function sessionModelReader(get: (key: string) => unknown): (sessionId: string) => SessionModelSelection | undefined;
