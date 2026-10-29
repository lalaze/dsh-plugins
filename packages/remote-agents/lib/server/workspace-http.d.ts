import { type WorkspaceTarget } from './workspace-domain.js';
import type { WorkspaceService } from './workspace-service.js';
import type { WorkspaceTunnels } from './workspace-tunnels.js';
/** `terminal.shell` is the Remote workspace launcher in DSH's shell menu, once installed. */
export interface WorkspaceFeatures {
    files: WorkspaceService;
    tunnels: WorkspaceTunnels;
    terminal?: {
        shell?: string;
    };
}
export declare function expectedTarget(value: unknown): WorkspaceTarget | undefined;
export declare function workspaceAction(features: WorkspaceFeatures, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
export declare function workspaceTransferHandler(files: WorkspaceService): (request: Request) => Promise<Response>;
