import type { WorkspaceTarget } from '../core/workspace.js';
import type { WorkspaceService } from './service.js';
export interface WorkspaceFeatures {
    files: WorkspaceService;
}
export declare function expectedTarget(value: unknown): WorkspaceTarget | undefined;
export declare function workspaceAction(features: WorkspaceFeatures, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
export declare function workspaceTransferHandler(files: WorkspaceService): (request: Request) => Promise<Response>;
