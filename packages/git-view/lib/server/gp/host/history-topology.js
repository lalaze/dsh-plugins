/**
 * Bounded raw-ancestry walk for a *filtered* history page.
 *
 * A page fetched with an effective search/author/since filter contains only the
 * commits that matched, so most of their parents are missing from the page and a
 * lane layout would draw dangling lines. One auxiliary `git rev-list --parents`
 * walk over the page's own full hashes returns those ancestors unfiltered:
 * rev-list's parent chain is not rewritten by --grep/--author, so no filter is
 * passed. `--topo-order` is deliberately omitted — it forces a full-DAG prep for
 * no benefit here.
 *
 * The walk is bounded and best-effort: it never fails the history page it
 * belongs to, and any failure or partial output degrades to `[]` — an incomplete
 * graph the caller must not present as complete (a shallow boundary also reports
 * no parents, which is indistinguishable from a true root).
 */
import { runCommand } from './core.js';
/** Hard cap on the auxiliary walk: deep enough for a filtered page, bounded
 * against a pathological DAG. */
export const HISTORY_TOPOLOGY_LIMIT = 10000;
/** Hard cap on the walk's stdout. The node cap alone does not bound a line: an
 * octopus merge can list thousands of parents on one commit. Over budget the
 * result is conservatively `[]` (an incomplete graph), never a partial parse. */
export const HISTORY_TOPOLOGY_MAX_BYTES = 2 * 1024 * 1024;
/** A full object id: 40 (sha1) or 64 (sha256) hex chars. */
const FULL_HASH = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
/**
 * Parse `git rev-list --parents` output: one `<hash> [<parent>…]` per line.
 * Returns null whenever the capture cannot be trusted as a complete ancestry —
 * a missing trailing newline (git always terminates each line, so a cut read can
 * land exactly on a 40-char hash and otherwise read as a parentless root), any
 * malformed line, or output past the node/byte budget. `[]` is a genuinely empty
 * walk, never a degraded one.
 */
export function parseGraphNodes(stdout) {
    if (stdout === '')
        return [];
    // Budget at the entry too, so a direct consumer cannot bypass the walk's cap.
    if (Buffer.byteLength(stdout, 'utf8') > HISTORY_TOPOLOGY_MAX_BYTES)
        return null;
    if (!stdout.endsWith('\n'))
        return null;
    const lines = [];
    for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (line !== '')
            lines.push(line);
    }
    // Cap before parsing: the walk asks for at most HISTORY_TOPOLOGY_LIMIT lines,
    // so more means the output did not honour it — and breaking early would
    // silently accept whatever malformed tail followed.
    if (lines.length > HISTORY_TOPOLOGY_LIMIT)
        return null;
    const nodes = [];
    const seen = new Set();
    for (const line of lines) {
        const fields = line.split(' ');
        const hash = fields[0];
        if (hash === undefined || !FULL_HASH.test(hash))
            return null;
        const parents = [];
        for (const parent of fields.slice(1)) {
            if (!FULL_HASH.test(parent))
                return null;
            parents.push(parent);
        }
        if (seen.has(hash))
            continue;
        seen.add(hash);
        nodes.push({ hash, parents });
    }
    return nodes;
}
/**
 * Walk the page's raw ancestry. Seeds must already be full hashes; anything
 * else is dropped rather than passed as argv. Resolves `[]` on every failure
 * path (spawn throw, cancel, timeout, non-zero exit, lossy output, malformed
 * output) so a filtered history page is never lost to this auxiliary command.
 */
export async function walkHistoryTopology(runner, root, seeds, signal) {
    const safeSeeds = seeds.filter((seed) => FULL_HASH.test(seed));
    if (safeSeeds.length === 0)
        return [];
    const argv = [
        'git', 'rev-list', '--parents', `--max-count=${HISTORY_TOPOLOGY_LIMIT}`,
        '--end-of-options', ...safeSeeds,
    ];
    const res = await runCommand(runner, argv, root, 'history-topology', signal);
    if (!('run' in res))
        return [];
    const { run } = res;
    if (run.cancelled || run.timedOut || run.exitCode !== 0 || run.stdoutLossy)
        return [];
    // Byte cap before parsing: a huge octopus parent list must not be walked or
    // held, and a read that hit the cap can never pass as a complete ancestry.
    if (Buffer.byteLength(run.stdout, 'utf8') > HISTORY_TOPOLOGY_MAX_BYTES)
        return [];
    return parseGraphNodes(run.stdout) ?? [];
}
