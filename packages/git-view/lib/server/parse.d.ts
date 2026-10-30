import type { Branch, Change, Commit } from './domain.js';
export declare const BRANCH_FORMAT: string;
export declare const LOG_FORMAT: string;
/** `[ahead 2, behind 1]`, `[gone]` or nothing. */
export declare function parseTrack(track: string): Pick<Branch, 'ahead' | 'behind' | 'gone'>;
/** Local and remote branches, current first and then by name, with every branch tip for the graph. */
export declare function parseBranches(text: string, current: string): {
    local: Branch[];
    remote: Branch[];
    tips: Record<string, string>;
};
export declare function parseLog(text: string): Commit[];
/** `git status --porcelain=v1 -z`: "XY path", where a rename or copy is followed by its original path. */
export declare function parseStatus(text: string, prefix: string): Change[];
/** Unmerged entries, as VS Code groups them under Merge Changes. */
export declare const isConflict: (code: string) => boolean;
/** The repository's folder name, from `git rev-parse --show-toplevel`. */
export declare const repoName: (toplevel: string) => string;
/** Why a network operation failed to sign in: HTTPS credentials or SSH keys. */
export declare function authFailure(stderr: string): 'https' | 'ssh' | undefined;
