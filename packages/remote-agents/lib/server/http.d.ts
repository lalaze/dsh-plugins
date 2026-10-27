import type { RemoteAgentsService } from './service.js';
import { ChatProjects } from './chat-projects.js';
import type { WorkspacePlacement } from './workspace-access.js';
import type { RemoteWorkspaces } from './remote-workspaces.js';
export declare function createHandler(service: RemoteAgentsService, projects?: ChatProjects, workspace?: (sessionId: string, signal: AbortSignal) => Promise<WorkspacePlacement>, workspaces?: Pick<RemoteWorkspaces, 'create'>): (request: Request) => Promise<Response>;
