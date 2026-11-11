import type { Context } from '@deepseek-ai/cordis';
import type { Store } from '../core/store.js';
import { WorkspaceAccess, type WorkspacePlacement } from './access.js';
import type { WorkspaceHosts } from './hosts.js';
import { type WorkspaceFeatures } from './http.js';
import { type GitBatch, type GitRun, type WorkspaceEntry, type WorkspaceTarget } from './domain.js';
import { RemoteWorkspaces } from './remote-workspaces.js';
import { WorkspaceTunnels } from './tunnels.js';
import { WorktreeService } from './worktrees.js';
import type { ArchiveCheck, ArchiveRequest, CreateRequest, JobAction, WorkspaceMachine, WorktreeJob, WorktreeProject, WorktreeProjectDetail } from './worktrees.js';
/**
 * What other DSH plugins on this host may do in a conversation's remote workspace, as the service `remoteAgentsWorkspaces`:
 * always on its verified machine and in its verified directory, which every call checks again. dsh-git-view runs Git
 * through it. Models use the `remote_workspace` tool instead, which offers no Git operation.
 */
export interface RemoteAgentsWorkspaces {
    /** Version 1 binds Git, transfers and cancellation to verified workspace targets. */
    readonly gitWorkspaceVersion: 1;
    target(sessionId: string, signal?: AbortSignal): Promise<WorkspaceTarget>;
    git(sessionId: string, batch: GitBatch, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<GitRun[]>;
    cancelGit(sessionId: string, id: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<void>;
    /** `path` is relative to the workspace, as in every call below; the revision is the file's SHA-256. */
    stat(sessionId: string, path: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{
        path: string;
        revision: string;
        size: number;
    }>;
    download(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<Buffer>;
    /** Replaces the file read at `revision`, or creates it with null; a file changed since is refused. */
    upload(sessionId: string, path: string, revision: string | null, data: Uint8Array, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{
        path: string;
        revision: string;
        size: number;
    }>;
    /** A folder's entries, folders first. Absent before Remote Agents 0.2.64. */
    list?(sessionId: string, path: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{
        path: string;
        entries: WorkspaceEntry[];
    }>;
    /** Deletes the file read at `revision`; a file changed since is refused. Absent before Remote Agents 0.2.64. */
    remove?(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: WorkspaceTarget): Promise<{
        path: string;
    }>;
}
/**
 * Worktree workspaces for other DSH plugins, as the service `remoteAgentsWorktrees`: what "New workspace from a project"
 * does, for a project on this computer or on a saved machine, and a way to run Git and shell commands in a workspace's
 * folder. A create or archive answers with a job; `job` reads how far it is and `act` answers what it stopped to ask.
 */
export interface RemoteAgentsWorktrees {
    readonly version: 1;
    projects(signal?: AbortSignal): Promise<WorktreeProject[]>;
    inspect(path: string, signal?: AbortSignal): Promise<WorktreeProjectDetail>;
    create(request: CreateRequest): WorktreeJob;
    job(id: string): WorktreeJob;
    act(id: string, action: JobAction): Promise<WorktreeJob>;
    archiveCheck(path: string, worktree: string, signal?: AbortSignal): Promise<ArchiveCheck>;
    archive(request: ArchiveRequest): WorktreeJob;
    /** `path` is a DSH workspace's path, as in a project or a finished create. */
    machine(path: string, signal?: AbortSignal): Promise<WorkspaceMachine>;
}
export interface Workspaces {
    /** Which saved machines and remote directory a local workspace path stands for. */
    access: WorkspaceAccess;
    /** The verified placement of a DSH conversation, rechecked so a workspace switch during verification yields none. */
    placement(sessionId: string, signal: AbortSignal): Promise<WorkspacePlacement>;
    workspaces: RemoteWorkspaces;
    features: WorkspaceFeatures & {
        tunnels: WorkspaceTunnels;
        worktrees: WorktreeService;
    };
}
/**
 * Remote workspace tools on the saved machines: files, sync, tunnels, the native terminal's Remote workspace shell, the
 * `remote_workspace` tool and its system prompt. The caller closes `features.tunnels`.
 */
export declare function installWorkspaces(ctx: Context, store: Store, machines: WorkspaceHosts): Promise<Workspaces>;
