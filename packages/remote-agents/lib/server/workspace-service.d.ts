import type { RemoteAgentsService } from './service.js';
import { type WorkspacePlacement } from './workspace-access.js';
import { type FileOperation, type SyncResult, type WorkspaceTarget } from './workspace-domain.js';
export type SessionPlacement = (id: string, signal: AbortSignal) => Promise<WorkspacePlacement>;
export declare const hash: (data: Uint8Array | string) => string;
/** A path exactly as given: names may begin or end with spaces, so trimming would address a different file. */
export declare function workspacePath(value: unknown, label: string): string;
export declare function fileOperation(raw: unknown): FileOperation;
export declare function revision(value: unknown): string | null;
/** All entry points derive host and cwd from the DSH session; callers can only assert an expected target. */
export declare class WorkspaceService {
    readonly agents: RemoteAgentsService;
    readonly placement: SessionPlacement;
    private readonly localCwd;
    private readonly syncing;
    constructor(agents: RemoteAgentsService, placement: SessionPlacement, localCwd: (id: string) => Promise<string | undefined>);
    target(sessionId: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<WorkspaceTarget>;
    operate(sessionId: string, raw: unknown, signal: AbortSignal, expected?: WorkspaceTarget): Promise<unknown>;
    download(sessionId: string, path: string, rev: string, signal: AbortSignal, expected?: WorkspaceTarget): Promise<Buffer>;
    upload(sessionId: string, path: string, rev: string | null, size: number, input: AsyncIterable<Uint8Array>, signal: AbortSignal, expected?: WorkspaceTarget): Promise<unknown>;
    sync(sessionId: string, direction: 'pull' | 'push', dryRun: boolean, signal: AbortSignal, expected?: WorkspaceTarget, planId?: string): Promise<SyncResult>;
}
