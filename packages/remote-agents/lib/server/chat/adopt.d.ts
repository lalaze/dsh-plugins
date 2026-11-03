import { type DshPermission } from '../core/domain.js';
import type { ChatProjects } from './projects.js';
/** What a continued conversation runs: its CLI's model route, reasoning effort and the permission matching its mode. */
export interface AdoptedSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
    permission?: DshPermission;
}
/** The DSH operations that put a continued session in the sidebar. */
export interface AdoptionHost {
    /** The local folder of the remote workspace for this directory, created when missing. */
    anchor(hostId: string, cwd: string, signal: AbortSignal): Promise<string>;
    /** The DSH workspace for a local folder, added when missing. */
    workspace(path: string): Promise<string>;
    /** DSH conversations by id, and whether each is still blank. */
    sessions(): Promise<Map<string, {
        blank: boolean;
    }>>;
    /** Create the conversation with this id, or reuse it while blank; DSH answers with the id it used. */
    create(workspaceId: string, sessionId: string): Promise<string>;
    select(sessionId: string, selection: AdoptedSelection): Promise<void>;
    rename(sessionId: string, title: string): Promise<void>;
    /** Start the conversation's first turn, which shows the saved history. */
    wake(sessionId: string): void;
    warn?(message: string): void;
}
/** The same task always maps to the same conversation, so an interrupted adoption reuses the blank one it made. */
export declare function adoptedSessionId(instance: string, taskId: string): string;
/**
 * Sessions another DSH started on a shared host become main conversations here, in their remote workspace and on
 * the same CLI session, so they can be continued. Each opens with its saved history; nothing is sent to the CLI.
 */
export declare class SharedChatAdoption {
    private readonly projects;
    private readonly host;
    private readonly options;
    private timer?;
    private running?;
    private readonly controller;
    /** Tasks that failed, retried later with a growing delay; a host that cannot be reached is not asked again each round. */
    private readonly retries;
    constructor(projects: ChatProjects, host: AdoptionHost, options?: {
        first?: number;
        every?: number;
    });
    start(): void;
    close(): void;
    /** One pass over the shared sessions; passes never overlap. */
    run(): Promise<void>;
    private round;
    /** False while the host's catalog is not ready to run this session's CLI; it is tried again next round. */
    private adopt;
    private selection;
}
