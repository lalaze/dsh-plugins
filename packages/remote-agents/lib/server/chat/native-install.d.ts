import type { Context } from '@deepseek-ai/cordis';
import type { RemoteAgentsService } from '../agents/service.js';
import type { Workspaces } from '../workspace/install.js';
import { NativeSharing } from './native-service.js';
/** All type-erased accesses below are to the audited 0.2.2-rc.1 host seams, not the older SDK type facade. */
export declare function installNativeSharing(ctx: Context, service: RemoteAgentsService, workspace: Workspaces): Promise<NativeSharing>;
