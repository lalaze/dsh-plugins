import type { RemoteAgentsService } from './agents/service.js';
import type { adoptModel } from './chat/adopt-model.js';
import { ChatProjects } from './chat/projects.js';
import type { NativeSharing } from './chat/native-service.js';
import type { WorkspacePlacement } from './core/access.js';
import type { RemoteWorkspaces } from './workspace/remote-workspaces.js';
import { type WorkspaceFeatures } from './workspace/http.js';
import type { Sharing } from './sharing/sharing.js';
export declare function createHandler(service: RemoteAgentsService, projects?: ChatProjects, workspace?: (sessionId: string, signal: AbortSignal) => Promise<WorkspacePlacement>, workspaces?: Partial<Pick<RemoteWorkspaces, 'create' | 'shared' | 'publish'>>, features?: WorkspaceFeatures, sharing?: Pick<Sharing, 'catalog' | 'set' | 'status'>, adopt?: ReturnType<typeof adoptModel>, native?: NativeSharing): (request: Request) => Promise<Response>;
