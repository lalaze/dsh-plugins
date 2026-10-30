import type { SnapshotDeps, GitPanelConfig } from './core.js';
import type { GitQueryRequest, GitQueryResponse } from './types.js';
export declare function runQuery(deps: SnapshotDeps, config: GitPanelConfig, request: GitQueryRequest): Promise<GitQueryResponse>;
/** Whether a path resolves inside the browse root, outside its .git tree, or
 * is absent (a deleted entry still listed by a stale tree). */
export type PathState = 'inside' | 'outside' | 'missing';
/**
 * Where `path` sits relative to `root` after symlinks are followed: the one
 * containment check shared by every endpoint that touches a browsable file.
 */
export declare function isInsideRoot(deps: SnapshotDeps, root: string, path: string, hideGit?: boolean): Promise<PathState>;
