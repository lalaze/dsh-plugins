import type { Context } from '@deepseek-ai/cordis';
import { type ProjectStatusEntry } from './domain.js';
/** What other host plugins may read of the statuses, as the service `projectStatus`. */
export interface ProjectStatus {
    readonly version: 1;
    /** The status of the project a folder belongs to: a workspace's path, or any checkout of the repository. */
    get(folder: string, signal?: AbortSignal): Promise<ProjectStatusEntry>;
    /** Every project that has been opened in the Status tab. */
    list(): Promise<ProjectStatusEntry[]>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        projectStatus: ProjectStatus;
    }
}
export declare const name = "dsh-project-status";
export declare const inject: string[];
/**
 * Host half: keeps one status file per project in the DSH home and serves it to the Status tab with what Git says about
 * the conversation's folder. A project is a repository with all of its worktrees and branches (see project.ts); the file
 * is plain Markdown that the agents working on this computer read and write themselves (see status-file.ts).
 */
export declare function apply(ctx: Context): void;
