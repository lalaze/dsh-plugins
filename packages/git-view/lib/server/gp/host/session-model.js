/**
 * @param get - the context's service lookup, called per request.
 * @returns a reader of a session's next model route; undefined when either
 *   service is missing, the session is unknown, the projection throws, or it
 *   names no complete provider/model pair.
 */
export function sessionModelReader(get) {
    return (sessionId) => {
        const sessions = get('sessions');
        const projections = get('sessionProjections');
        const session = sessions?.get(sessionId);
        if (session === undefined || projections === undefined)
            return undefined;
        try {
            const next = projections.snapshot(session, ['modelSelection']).values?.modelSelection?.next;
            if (next == null || typeof next.provider !== 'string' || typeof next.model !== 'string')
                return undefined;
            if (next.provider === '' || next.model === '')
                return undefined;
            return {
                provider: next.provider,
                model: next.model,
                ...(typeof next.reasoningEffort === 'string' && next.reasoningEffort !== ''
                    ? { reasoningEffort: next.reasoningEffort }
                    : {}),
            };
        }
        catch {
            return undefined;
        }
    };
}
