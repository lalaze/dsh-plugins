import { type ProjectStatusEntry, type StatusAnswer } from './domain.js';
import { type RemoteWorktrees } from './git.js';
import { type StatusStore } from './store.js';
/** A conversation as DSH lists it, as far as it is read here. */
export interface SessionRow {
    sessionId?: string;
    cwd?: string;
    updatedAt?: number | string;
    blank?: boolean;
    parentSessionId?: string | null;
}
export interface ServiceOptions {
    /** The folder a conversation works in now. */
    cwd(sessionId: string): Promise<string | undefined>;
    /** dsh-remote-terminals' worktree service, when that plugin is there. */
    worktrees(): RemoteWorktrees | undefined;
    /** Every conversation of this DSH. */
    sessions(): Promise<SessionRow[]>;
    now?(): number;
}
export declare class ProjectStatusService {
    private readonly store;
    private readonly options;
    private readonly inspections;
    private readonly now;
    constructor(store: StatusStore, options: ServiceOptions);
    /** The status of the project a conversation works in. */
    get(sessionId: string, signal?: AbortSignal): Promise<StatusAnswer>;
    /**
     * Makes one change to the project's file and leaves the rest of it as it is. The tab saves as the user types and ticks,
     * while agents edit the same file, so what is checked is the one text the change replaces: a change to another goal or
     * another text meanwhile is no conflict.
     * @param language - of the headings, for a file that has none yet.
     */
    change(sessionId: string, input: unknown, language: unknown, signal?: AbortSignal): Promise<StatusAnswer>;
    /** For other plugins: the status of the project a folder belongs to. */
    forFolder(folder: string, signal?: AbortSignal): Promise<ProjectStatusEntry>;
    /** For other plugins: every project that has been opened in the tab, with what its file says now. */
    list(): Promise<ProjectStatusEntry[]>;
    private folderOf;
    private inspected;
    private answer;
    /**
     * Conversations started in the project's checkouts, or in a folder inside one. A remote workspace's conversations all
     * start in its one anchor folder on this computer.
     */
    private conversations;
}
