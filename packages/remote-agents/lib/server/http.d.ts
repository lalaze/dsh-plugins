import type { RemoteAgentsService } from './agents/service.js';
import { ChatProjects } from './chat/projects.js';
import type { WorkspacePlacement } from './workspace/access.js';
import type { RemoteWorkspaces } from './workspace/remote-workspaces.js';
import { type WorkspaceFeatures } from './workspace/http.js';
import type { Sharing } from './sharing/sharing.js';
export declare function createHandler(service: RemoteAgentsService, projects?: ChatProjects, workspace?: (sessionId: string, signal: AbortSignal) => Promise<WorkspacePlacement>, workspaces?: Partial<Pick<RemoteWorkspaces, 'create' | 'shared' | 'publish'>>, features?: WorkspaceFeatures, sharing?: Pick<Sharing, 'catalog' | 'set' | 'status'>): (request: Request) => Promise<Response>;
