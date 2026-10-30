import type { GitRunner } from './git.js';
import type { GitGraphNode } from './types.js';
/** Hard cap on the auxiliary walk: deep enough for a filtered page, bounded
 * against a pathological DAG. */
export declare const HISTORY_TOPOLOGY_LIMIT = 10000;
/** Hard cap on the walk's stdout. The node cap alone does not bound a line: an
 * octopus merge can list thousands of parents on one commit. Over budget the
 * result is conservatively `[]` (an incomplete graph), never a partial parse. */
export declare const HISTORY_TOPOLOGY_MAX_BYTES: number;
/**
 * Parse `git rev-list --parents` output: one `<hash> [<parent>…]` per line.
 * Returns null whenever the capture cannot be trusted as a complete ancestry —
 * a missing trailing newline (git always terminates each line, so a cut read can
 * land exactly on a 40-char hash and otherwise read as a parentless root), any
 * malformed line, or output past the node/byte budget. `[]` is a genuinely empty
 * walk, never a degraded one.
 */
export declare function parseGraphNodes(stdout: string): GitGraphNode[] | null;
/**
 * Walk the page's raw ancestry. Seeds must already be full hashes; anything
 * else is dropped rather than passed as argv. Resolves `[]` on every failure
 * path (spawn throw, cancel, timeout, non-zero exit, lossy output, malformed
 * output) so a filtered history page is never lost to this auxiliary command.
 */
export declare function walkHistoryTopology(runner: GitRunner, root: string, seeds: readonly string[], signal?: AbortSignal): Promise<GitGraphNode[]>;
