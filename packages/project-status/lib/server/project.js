import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { StatusError } from './store.js';
/** Usable as a file name on every system: letters, digits, dot, dash and underscore. */
export function slugify(value) {
    const slug = value.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60).replace(/[-.]+$/, '');
    return slug || 'project';
}
/** One batch, so a machine reached over SSH is asked once. The first answer names the repository; the rest are facts. */
const STEPS = [
    { argv: ['rev-parse', '--git-common-dir'] },
    { argv: ['symbolic-ref', '-q', '--short', 'HEAD'] },
    { argv: ['status', '--porcelain'] },
    { argv: ['remote'] },
    { argv: ['rev-list', '--count', 'HEAD', '--not', '--remotes'] },
    { argv: ['worktree', 'list', '--porcelain'] },
    { argv: ['stash', 'list'] },
    { argv: ['log', '-1', '--format=%ct'] },
];
const lines = (result) => result.stdout.split('\n').filter(line => line.trim() !== '');
/** Checkouts in `git worktree list --porcelain` output; a bare repository's own entry is not one. */
export function checkoutsOf(output) {
    const paths = [];
    let current;
    for (const line of output.split('\n')) {
        if (line.startsWith('worktree '))
            current = paths.push(line.slice(9)) - 1;
        else if (line === 'bare' && current !== undefined) {
            paths.splice(current, 1);
            current = undefined;
        }
    }
    return paths;
}
export function factsOf(results) {
    const [, head, status, remotes, unpushed, worktrees, stashes, last] = results;
    if (status.code !== 0)
        throw new StatusError('Git could not read this folder');
    const commit = last.code === 0 ? Number(last.stdout.trim()) : NaN, ahead = unpushed.code === 0 ? Number(unpushed.stdout.trim()) : NaN;
    return {
        ...(head.code === 0 && head.stdout.trim() ? { branch: head.stdout.trim() } : {}),
        dirty: lines(status).length,
        // With no remote every commit would count as unpushed, which says nothing.
        unpushed: lines(remotes).length && Number.isFinite(ahead) ? ahead : lines(remotes).length ? 0 : null,
        worktrees: Math.max(0, checkoutsOf(worktrees.stdout).length - 1),
        stashes: stashes.code === 0 ? lines(stashes).length : 0,
        ...(Number.isFinite(commit) && commit > 0 ? { lastCommit: commit * 1000 } : {}),
    };
}
/**
 * Which project a folder belongs to, and what Git knows about it.
 *
 * A repository is named by its common Git folder, which every worktree shares, so all of its checkouts and branches are
 * one project. The id is dsh-remote-terminals' name for the repository's worktree folder (`<name>-<hash>`), so the two
 * are recognizably the same thing on this computer. It is a path's hash: another clone, or the same repository on
 * another machine, is another project.
 */
export async function inspect(place, signal) {
    const { path, remote } = place, key = (value) => createHash('sha256').update(remote ? `${remote.hostId}\0${value}` : value).digest('hex').slice(0, 8);
    const local = (value) => remote ? Promise.resolve(value) : realpath(value).catch(() => value);
    const results = await place.git(STEPS, signal), common = results[0];
    if (common.code !== 0 || !common.stdout.trim()) {
        const root = await local(place.folder), name = path.basename(root) || root;
        return { project: { id: `${slugify(name)}-${key(root)}`, name, root, git: false, ...(remote ? { machine: remote.label } : {}) }, checkouts: [root] };
    }
    const commonDir = await local(path.resolve(place.folder, common.stdout.replace(/\n$/, '')));
    // A repository's own `.git` folder sits in its main checkout; a bare repository is its common folder.
    const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    const name = path.basename(root).replace(/\.git$/, '') || 'repository';
    const project = { id: `${slugify(name)}-${key(commonDir)}`, name, root, git: true, ...(remote ? { machine: remote.label } : {}) };
    const listed = checkoutsOf(results[5].stdout), checkouts = listed.length ? listed : [root];
    try {
        return { project, facts: factsOf(results), checkouts };
    }
    catch (error) {
        return { project, factsError: error instanceof Error ? error.message : String(error), checkouts };
    }
}
