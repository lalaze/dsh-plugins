import type { Context } from '@deepseek-ai/cordis';
import type { RemoteAgentsMachines } from './core/machines.js';
import { TuiFiles } from './tui-files.js';
import type { TuiStore } from './tui-state.js';
import { TuiSessions } from './tui.js';
import { WorktreeService } from './worktrees.js';
import type { ArchiveCheck, ArchiveRequest, CreateRequest, JobAction, WorkspaceMachine, WorktreeJob, WorktreeProject, WorktreeProjectDetail } from './worktrees.js';
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
/** `terminal.shell` is the Remote workspace launcher in DSH's shell menu, once installed. */
export interface Terminals {
    terminal: {
        shell?: string;
    };
    worktrees: WorktreeService;
    tui: TuiSessions;
}
/**
 * Terminals that open in a conversation's remote workspace and outlive DSH, conversations whose view is Claude Code or
 * Codex in such a terminal, and workspaces made from a project's Git worktrees. They reach the saved machines only
 * through `machines`, which Remote Agents provides.
 * @param tuiFile - the file `store` saves to, which a terminal's launcher reads.
 */
export declare function installTerminals(ctx: Context, machines: RemoteAgentsMachines, store: TuiStore, tuiFile: string): Terminals;
/** A file dropped or pasted into a TUI conversation, which comes back as its absolute path on the conversation's machine. */
export declare function tuiFilesHandler(files: TuiFiles): (request: Request) => Promise<Response>;
/** Worktree workspaces: a project's DSH workspace path, a worktree's path on its machine, and operation IDs. */
export declare function worktreeAction(worktrees: WorktreeService, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
/** The requests about TUI conversations. */
export declare function tuiAction(tui: TuiSessions, action: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
