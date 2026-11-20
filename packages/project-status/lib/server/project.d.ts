import type { Facts, ProjectInfo } from './domain.js';
import type { GitResult, Workplace } from './git.js';
/** Usable as a file name on every system: letters, digits, dot, dash and underscore. */
export declare function slugify(value: string): string;
/** What one round of Git says about a conversation's folder. */
export interface Inspection {
    project: ProjectInfo;
    facts?: Facts;
    factsError?: string;
    /** Every checkout of the project, the main one first; the folder itself outside Git. */
    checkouts: string[];
}
/** Checkouts in `git worktree list --porcelain` output; a bare repository's own entry is not one. */
export declare function checkoutsOf(output: string): string[];
export declare function factsOf(results: GitResult[]): Facts;
/**
 * Which project a folder belongs to, and what Git knows about it.
 *
 * A repository is named by its common Git folder, which every worktree shares, so all of its checkouts and branches are
 * one project. The id is dsh-remote-terminals' name for the repository's worktree folder (`<name>-<hash>`), so the two
 * are recognizably the same thing on this computer. It is a path's hash: another clone, or the same repository on
 * another machine, is another project.
 */
export declare function inspect(place: Workplace, signal?: AbortSignal): Promise<Inspection>;
