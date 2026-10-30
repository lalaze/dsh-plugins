/** Field and record separators of the formats below; Git writes them from `%1f`/`%x1f`, so arguments stay printable. */
const FIELD = '\x1f', RECORD = '\x1e';
export const BRANCH_FORMAT = ['refname', 'objectname', 'objectname:short', 'committerdate:iso8601', 'subject', 'upstream:short', 'upstream:track', 'symref']
    .map(field => `%(${field})`).join('%1f') + '%1e';
export const LOG_FORMAT = ['%H', '%P', '%an', '%ai', '%s'].join('%x1f') + '%x1e';
/** Commit messages and names are shown on one line; control characters other than the separators become spaces. */
const clean = (text) => text.replace(/[\0-\x1d\x7f]/g, ' ');
const records = (text) => text.split(RECORD).map(record => record.replace(/^\n/, '')).filter(Boolean);
/** `[ahead 2, behind 1]`, `[gone]` or nothing. */
export function parseTrack(track) {
    if (track === '[gone]')
        return { gone: true };
    const ahead = /ahead (\d+)/.exec(track)?.[1], behind = /behind (\d+)/.exec(track)?.[1];
    return { ...ahead ? { ahead: Number(ahead) } : {}, ...behind ? { behind: Number(behind) } : {} };
}
/** Local and remote branches, current first and then by name, with every branch tip for the graph. */
export function parseBranches(text, current) {
    const local = [], remote = [], tips = Object.create(null);
    for (const record of records(text)) {
        const [ref, sha, short, date, subject, upstream, track, symref] = record.split(FIELD);
        // A remote's HEAD only names its default branch.
        if (!ref || !sha || symref)
            continue;
        const isRemote = ref.startsWith('refs/remotes/'), name = clean(ref.slice(isRemote ? 13 : 11));
        tips[name] = sha;
        const branch = { name, sha, short, date, subject: clean(subject ?? '').slice(0, 200), current: !isRemote && name === current,
            ...upstream ? { upstream: clean(upstream) } : {}, ...isRemote ? {} : parseTrack(track ?? '') };
        (isRemote ? remote : local).push(branch);
    }
    const order = (a, b) => Number(b.current) - Number(a.current) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { local: local.sort(order), remote: remote.sort(order), tips };
}
export function parseLog(text) {
    const commits = [], seen = new Set();
    for (const record of records(text)) {
        const [sha, parents, author, date, subject] = record.split(FIELD);
        if (!sha || seen.has(sha))
            continue;
        seen.add(sha);
        commits.push({ sha, parents: parents ? parents.split(' ') : [], author: clean(author ?? ''), date: date ?? '', subject: clean(subject ?? '').slice(0, 300) });
    }
    return commits;
}
/** `git status --porcelain=v1 -z`: "XY path", where a rename or copy is followed by its original path. */
export function parseStatus(text, prefix) {
    const changes = [], parts = text.split('\0');
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (entry.length < 4)
            continue;
        const code = entry.slice(0, 2), path = entry.slice(3), change = { code, path };
        if (code[0] === 'R' || code[0] === 'C')
            change.from = parts[++i];
        if (path.startsWith(prefix) && path.length > prefix.length)
            change.local = path.slice(prefix.length);
        changes.push(change);
    }
    return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
/** Unmerged entries, as VS Code groups them under Merge Changes. */
export const isConflict = (code) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
/** The repository's folder name, from `git rev-parse --show-toplevel`. */
export const repoName = (toplevel) => toplevel.trim().split(/[\\/]/).filter(Boolean).pop() ?? toplevel.trim();
/** Why a network operation failed to sign in: HTTPS credentials or SSH keys. */
export function authFailure(stderr) {
    if (/Permission denied \(publickey|Host key verification failed|Could not read from remote repository/i.test(stderr))
        return 'ssh';
    if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP Basic: Access denied|Invalid username or (password|token)|requested URL returned error: 40[13]/i.test(stderr))
        return 'https';
}
