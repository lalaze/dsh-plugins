/**
 * Nested-repository discovery for the repository switcher (issue #83).
 *
 * A session's cwd is often a workspace directory that is *not* itself a
 * repository but holds one per project (`workspace/site/.git`,
 * `workspace/api/.git`). The panel's original single-repository view only ever
 * asked git for the cwd's own work-tree top, so those projects were invisible.
 * This module scans the cwd for repository roots and resolves the selector the
 * client sends back.
 *
 * Trust boundary: the selector is a cwd-relative path, never an absolute one.
 * Every candidate is realpath'd and re-checked for containment inside the
 * realpath'd cwd before git runs in it, so an absolute path, a `..` escape or a
 * symlink pointing outside the cwd can never become a repository root.
 */
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSafePath } from './validate.js';
/** Directories the scanner descends into, cwd-relative depth. Deep enough for
 * the common group/project layout, shallow enough that one scan stays cheap. */
export const REPO_SCAN_DEPTH = 3;
/** Directory ceiling for one scan: a workspace with a huge tree stops early
 * instead of walking everything on every panel mount. */
export const REPO_SCAN_LIMIT = 2000;
/** Repository ceiling for one result list; past this the switcher would be
 * unusable anyway, and the client addresses entries by path, not index. */
export const REPO_RESULT_LIMIT = 50;
/** Never a repository of its own, and the two names that would turn a scan
 * into a full dependency-tree walk. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);
/** Windows path comparison is case-insensitive; POSIX is not. */
export function samePath(a, b) {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** True when `target` is `root` or sits inside it. */
export function isWithin(root, target) {
    if (samePath(root, target))
        return true;
    const prefix = root.endsWith(sep) ? root : root + sep;
    return process.platform === 'win32'
        ? target.toLowerCase().startsWith(prefix.toLowerCase())
        : target.startsWith(prefix);
}
/** cwd-relative POSIX path of `target`, or null when it escapes `root`. */
export function relativeRepoPath(root, target) {
    const rel = relative(root, target);
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../'))
        return null;
    return rel.split(sep).join('/');
}
/** A directory is a work-tree top when it has a `.git` entry: a directory in a
 * normal clone, a file in a worktree or submodule. */
async function hasGitEntry(fs, dir) {
    try {
        await fs.stat(join(dir, '.git'));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Breadth-first scan of `cwd` for repository roots. A directory with a
 * `.git` is a root and is not descended into (its own nested repositories, if
 * any, belong to it, not to the workspace). Symlinked directories are skipped
 * because the dirent reports them as non-directories. Bounded by depth, scan
 * count and result count; the result is sorted by path so the switcher order is
 * stable.
 */
export async function scanRepos(fs, cwd, opts = {}) {
    const root = await fs.realpath(cwd).catch(() => cwd);
    const depth = opts.depth ?? REPO_SCAN_DEPTH;
    const scanLimit = opts.scanLimit ?? REPO_SCAN_LIMIT;
    const resultLimit = opts.resultLimit ?? REPO_RESULT_LIMIT;
    const found = [];
    const queue = [{ dir: root, depth: 0 }];
    let scanned = 0;
    while (queue.length > 0) {
        const item = queue.shift();
        if (item.depth >= depth)
            continue;
        let entries;
        try {
            entries = await fs.readdir(item.dir);
        }
        catch {
            continue;
        }
        const dirs = entries
            .filter((e) => e.isDirectory && !SKIP_DIRS.has(e.name))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of dirs) {
            if (found.length >= resultLimit || scanned >= scanLimit) {
                found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
                return found;
            }
            scanned += 1;
            const abs = join(item.dir, entry.name);
            if (await hasGitEntry(fs, abs)) {
                // realpath can differ from the listed path (a symlinked *parent*, a
                // case-insensitive filesystem); the root must be the real directory.
                const real = await fs.realpath(abs).catch(() => null);
                if (real === null || !isWithin(root, real))
                    continue;
                const rel = relativeRepoPath(root, real);
                if (rel === null)
                    continue;
                found.push({ path: rel, root: real, name: basename(real) });
                continue;
            }
            queue.push({ dir: abs, depth: item.depth + 1 });
        }
    }
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return found;
}
/**
 * Resolve a repository selector to the directory inside the session cwd.
 *
 * Rejects anything that is not a safe relative path, anything that realpaths
 * outside the cwd (absolute paths and `..` never reach realpath; a symlink
 * that escapes does), the cwd itself (that is the empty selector), and a
 * `.git` directory. Whether the directory is a work-tree top is decided by the
 * caller, which asks git.
 */
export async function repoDirFor(fs, cwd, rel) {
    if (!isSafePath(rel))
        return { ok: false };
    const root = await fs.realpath(cwd).catch(() => cwd);
    const real = await fs.realpath(resolve(root, rel)).catch(() => null);
    if (real === null || !isWithin(root, real) || samePath(real, root))
        return { ok: false };
    if (basename(real) === '.git')
        return { ok: false };
    return { ok: true, dir: real };
}
