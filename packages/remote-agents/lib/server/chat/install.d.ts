import type { ClaudeGoalBridge } from './claude-goal.js';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteAgentsService } from '../agents/service.js';
import type { WorkspaceAccess } from '../core/access.js';
import type { RemoteWorkspaces } from '../workspace/remote-workspaces.js';
import type { WorkspaceService } from '../workspace/service.js';
import type { ChatProjects } from './projects.js';
/** Remote CLI models in DSH's model picker and main conversation. */
export declare function installChat(ctx: Context, service: RemoteAgentsService, projects: ChatProjects, workspace: {
    access: WorkspaceAccess;
    files: WorkspaceService;
    workspaces: RemoteWorkspaces;
}, claudeGoals?: ClaudeGoalBridge): void;
