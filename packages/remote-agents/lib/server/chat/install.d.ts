import type { Context } from '@deepseek-ai/cordis';
import type { RemoteAgentsService } from '../agents/service.js';
import type { Store } from '../core/store.js';
import type { WorkspaceAccess } from '../workspace/access.js';
import type { WorkspaceService } from '../workspace/service.js';
import type { ChatProjects } from './projects.js';
/** Conversations saved by 0.2.53 and earlier stored a remote tool row out of order, and DSH refuses to reopen them. */
export declare function scheduleSessionRepair(ctx: Context, store: Store): void;
/** Remote CLI models in DSH's model picker and main conversation. */
export declare function installChat(ctx: Context, service: RemoteAgentsService, projects: ChatProjects, workspace: {
    access: WorkspaceAccess;
    files: WorkspaceService;
}): void;
