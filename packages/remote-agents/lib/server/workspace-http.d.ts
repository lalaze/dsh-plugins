import { type WorkspaceTarget } from './workspace-domain.js';
import type { WorkspaceMigration } from './workspace-migration.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceTunnels } from './workspace-tunnels.js';
export interface WorkspaceFeatures {
    files: WorkspaceService;
    tunnels: WorkspaceTunnels;
    migration: WorkspaceMigration;
}
export declare function expectedTarget(value: unknown): WorkspaceTarget | undefined;
export declare function workspaceAction(features: WorkspaceFeatures, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
export declare function workspaceTransferHandler(files: WorkspaceService): (request: Request) => Promise<Response>;
