import { type ProjectSource, type ProjectSourceStatus } from './domain.js';
/** What recording a source carries to the workspace's machine: the source, the script, and its key if it has one. */
export interface ProjectBundle {
    source: ProjectSource;
    script: string;
    key?: string;
}
/** The section agent instruction files get. */
export declare function agentSection(source: ProjectSource): string;
/** The README next to the script. */
export declare function projectReadme(source: ProjectSource): string;
export declare function readProjectSource(root: string): Promise<ProjectSourceStatus>;
/**
 * Records `bundle` in the project at `root`, or with null removes what an earlier recording wrote. Agent instruction
 * files keep everything outside the plugin's section; one the removal leaves empty is deleted.
 */
export declare function writeProjectSource(root: string, bundle: ProjectBundle | null, home?: string): Promise<ProjectSourceStatus>;
