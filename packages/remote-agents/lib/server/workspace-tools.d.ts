import { type DshPermission } from './domain.js';
import type { ToolDefinition, ToolHost } from './tools.js';
import { type WorkspaceService } from './workspace-service.js';
/** `permission` reads the calling agent's DSH permission; undefined (a custom permission) asks before every change. */
export declare function workspaceTools(workspaces: WorkspaceService, host: ToolHost, permission?: (agent: unknown) => DshPermission | undefined): ToolDefinition[];
