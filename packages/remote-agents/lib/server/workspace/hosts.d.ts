import type { DirectoryListing, Host, SharedWorkspace } from '../core/domain.js';
import type { Store } from '../core/store.js';
import type { WorkspaceFiles } from './files.js';
/**
 * What remote workspaces need from the saved machines. The agents service provides it, so workspace operations reuse
 * each machine's SSH connection and pinned identity rather than keeping a second machine registry.
 */
export interface WorkspaceHosts {
    readonly store: Pick<Store, 'directory' | 'hosts' | 'seenWorkspaces'>;
    hosts(): Pick<Host, 'id' | 'label'>[];
    connect(hostId: string): Promise<unknown>;
    /** Canonicalize a remote directory, `~` included, and optionally list its subdirectories. */
    browse(hostId: string, path?: string, options?: {
        entries?: boolean;
    }): Promise<DirectoryListing>;
    /** Run `action` on the machine's connection once `verify` confirms the workspace still belongs to it. */
    withWorkspace<T>(hostId: string, verify: () => Promise<void>, action: (files: WorkspaceFiles) => Promise<T>): Promise<T>;
    /** Workspaces DSH instances sharing the machine added, and marking them offered here or adding one. */
    sharedWorkspaces(hostId: string): Promise<SharedWorkspace[]>;
    seeWorkspaces(hostId: string, paths: string[]): Promise<void>;
    shareWorkspace(hostId: string, path: string): Promise<void>;
}
