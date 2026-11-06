import { RemoteError } from '../core/domain.js';
/**
 * Give a new conversation a model its workspace can run, for that conversation only. DSH's `selectModel` also saves its
 * choice as the default for later conversations, and only the user's own choice should do that, so the default is put back.
 */
export function adoptModel(get) {
    return async (sessionId, selection) => {
        const sessions = get('sessionController'), defaults = get('agentDefaultModel');
        if (!sessions || !defaults)
            throw new RemoteError('DSH model selection is not available yet', 501);
        const row = (await sessions.list({})).items?.find(item => item.sessionId === sessionId);
        if (!row?.blank)
            throw new RemoteError('This conversation has already started', 409);
        const previous = defaults.currentSelection();
        await sessions.selectModel({ sessionId, ...selection });
        await defaults.saveSelection(previous);
    };
}
