import type { Context } from '@deepseek-ai/cordis';
import type { Store } from '../core/store.js';
import { WorkspaceAccess, type WorkspacePlacement } from './access.js';
import type { WorkspaceHosts } from './hosts.js';
import { type WorkspaceFeatures } from './http.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { WorkspaceTunnels } from './tunnels.js';
export interface Workspaces {
    /** Which saved machines and remote directory a local workspace path stands for. */
    access: WorkspaceAccess;
    /** The verified placement of a DSH conversation, rechecked so a workspace switch during verification yields none. */
    placement(sessionId: string, signal: AbortSignal): Promise<WorkspacePlacement>;
    workspaces: RemoteWorkspaces;
    features: WorkspaceFeatures & {
        tunnels: WorkspaceTunnels;
    };
}
/**
 * Remote workspace tools on the saved machines: files, sync, tunnels, the native terminal's Remote workspace shell, the
 * `remote_workspace` tool and its system prompt. The caller closes `features.tunnels`.
 */
export declare function installWorkspaces(ctx: Context, store: Store, machines: WorkspaceHosts): Promise<Workspaces>;
