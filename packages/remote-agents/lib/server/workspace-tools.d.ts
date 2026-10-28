import type { ToolDefinition, ToolHost } from './tools.js';
import { type WorkspaceService } from './workspace-service.js';
export declare function workspaceTools(workspaces: WorkspaceService, host: ToolHost): ToolDefinition[];
