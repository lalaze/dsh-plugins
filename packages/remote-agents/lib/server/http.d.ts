import type { RemoteAgentsService } from './service.js';
import { ChatProjects } from './chat-projects.js';
import type { WorkspacePlacement } from './workspace-access.js';
export declare function createHandler(service: RemoteAgentsService, projects?: ChatProjects, workspace?: (sessionId: string, signal: AbortSignal) => Promise<WorkspacePlacement>): (request: Request) => Promise<Response>;
