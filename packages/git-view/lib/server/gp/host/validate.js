/**
 * Input validation for the host trust boundary. Paths, refs, and branch names
 * arriving over RPC are the only untrusted argv material; every git command
 * that would otherwise place them in an option position is guarded here.
 * Subcommands that accept `--end-of-options` additionally pass the value after
 * it (belt-and-suspenders); `checkout` and `reset` do not — those subcommands
 * reject that option — so for them this validation is the only guard.
 */
import { isAbsolute, normalize } from 'node:path';
/** A repository-relative path is safe when it stays inside the work tree. */
export function isSafePath(path) {
    if (path === '' || isAbsolute(path))
        return false;
    const norm = normalize(path);
    if (norm === '..' || norm.startsWith('../') || norm.startsWith('..\\'))
        return false;
    return true;
}
// Control chars, space, DEL, and the glob / rev-expression metacharacters a
// plain branch/tag/commit ref we filter by must never contain.
const REV_META = /[\x00-\x20\x7f~^:?*[\\]/;
/**
 * A ref (branch / tag / commit-ish) is safe as a bare argv element: no leading
 * `-` (would be parsed as a git option — the `--output=` file-write vector),
 * no whitespace/control chars, no glob or rev-range metacharacters.
 */
export function isSafeRev(input) {
    if (input === '' || input.startsWith('-'))
        return false;
    if (REV_META.test(input))
        return false;
    if (input.includes('..') || input.includes('@{'))
        return false;
    return true;
}
/** A branch name for `git checkout`: the ref rules plus no leading slash. */
export function isSafeBranchName(name) {
    return isSafeRev(name) && !name.startsWith('/');
}
/** A git remote name for `git push -u <remote> HEAD`. Allows the characters git
 * permits in a remote name (alphanumerics, `._/-`) but never a leading dash, so
 * a configured remote can never slip into the option position. */
export function isSafeRemoteName(name) {
    return /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(name) && name.length <= 128;
}
