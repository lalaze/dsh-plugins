import { type DshPermission } from '../core/domain.js';
import type { ToolDefinition, ToolHost } from '../core/dsh-host.js';
import { type WorkspaceService } from './service.js';
/** `permission` reads the calling agent's DSH permission; undefined (a custom permission) asks before every change. */
export declare function workspaceTools(workspaces: WorkspaceService, host: ToolHost, permission?: (agent: unknown) => DshPermission | undefined): ToolDefinition[];
