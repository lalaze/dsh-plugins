import { type WorkspaceTarget } from './domain.js';
import type { WorkspaceService } from './service.js';
import type { WorkspaceTunnels } from './tunnels.js';
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
