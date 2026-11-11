export interface Bug {
    id: string;
    workspaceId: string;
    title: string;
    /** As TAPD stores it: HTML. */
    description: string;
    owner: string;
    status: string;
    labels: string[];
    module: string;
    priority: string;
}
export type TapdAuth = {
    kind: 'bearer';
    token: string;
} | {
    kind: 'basic';
    user: string;
    token: string;
};
export interface TapdSettings {
    apiBase: string;
    auth: TapdAuth;
    /** Whose bugs to fetch: the TAPD name in "current owner". */
    owner: string;
    workspaces: {
        id: string;
        name: string;
    }[];
    /** Statuses to fetch, as API values (`new`) or as the workspace shows them (`待处理`). */
    statuses: string[];
    /** Written when a fix is accepted. */
    doneStatus: string;
    /** Written when a task starts; empty leaves the bug's status alone. */
    inProgressStatus: string;
    /** Whether a fix that waits for a person is said in a comment on the bug. */
    commentOnReview: boolean;
}
export declare const defaultSettings: () => TapdSettings;
/** Settings as a person typed them, checked; throws what to fix. */
export declare function settingsFrom(raw: unknown): TapdSettings;
/** Settings for a page: a saved secret is never sent back, only whether there is one. */
export type PublicSettings = TapdSettings & {
    hasToken: boolean;
};
export declare const publicSettings: (settings: TapdSettings) => PublicSettings;
export declare class SettingsStore {
    private readonly path;
    settings: TapdSettings;
    constructor(path: string);
    open(): Promise<void>;
    /** An empty token keeps the saved one: a page never receives it, so it cannot send it back. */
    save(raw: unknown): Promise<void>;
}
