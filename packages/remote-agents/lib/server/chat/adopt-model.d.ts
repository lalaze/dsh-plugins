type Selection = {
    provider: string;
    model: string;
    reasoningEffort?: string;
};
/**
 * Give a new conversation a model its workspace can run, for that conversation only. DSH's `selectModel` also saves its
 * choice as the default for later conversations, and only the user's own choice should do that, so the default is put back.
 */
export declare function adoptModel(get: (name: string) => unknown): (sessionId: string, selection: Selection) => Promise<void>;
export {};
