import { RemoteError } from '../core/domain.js';

type Selection = { provider: string; model: string; reasoningEffort?: string };
interface Sessions {
  list(request: object): Promise<{ items?: { sessionId: string; blank?: boolean }[] }>;
  selectModel(request: Selection & { sessionId: string }): Promise<unknown>;
}
interface Defaults { currentSelection(): Selection; saveSelection(next: Selection): Promise<void> }

/**
 * Give a new conversation a model its workspace can run, for that conversation only. DSH's `selectModel` also saves its
 * choice as the default for later conversations, and only the user's own choice should do that, so the default is put back.
 */
export function adoptModel(get: (name: string) => unknown) {
  return async (sessionId: string, selection: Selection): Promise<void> => {
    const sessions = get('sessionController') as Sessions | undefined, defaults = get('agentDefaultModel') as Defaults | undefined;
    if (!sessions || !defaults) throw new RemoteError('DSH model selection is not available yet', 501);
    const row = (await sessions.list({})).items?.find(item => item.sessionId === sessionId);
    if (!row?.blank) throw new RemoteError('This conversation has already started', 409);
    const previous = defaults.currentSelection();
    await sessions.selectModel({ sessionId, ...selection });
    await defaults.saveSelection(previous);
  };
}
