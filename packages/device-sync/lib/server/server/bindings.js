/**
 * Which SSH directory a workspace stands for. remote-agents (and dsh-remote) give each remote workspace a local
 * placeholder folder, `$DSH_HOME/remote-workspaces/<machine>/<folder>/`, holding `.dsh-remote-meta.json` with the
 * host, user, port and remote path. A workspace inside such a folder is the matching directory below that path.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { normalizeRemotePath } from '../shared/protocol.js';
const META = '.dsh-remote-meta.json';
const MAX_META_BYTES = 1_048_576;
const under = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
/** The binding of the workspace at `path`, or undefined when it is not a readable remote workspace. */
export async function readRemoteBinding(home, path) {
    const root = resolve(home, 'remote-workspaces'), local = resolve(path);
    if (!under(root, local))
        return undefined;
    const parts = relative(root, local).split(sep);
    if (parts.length < 2 || !parts[0] || !parts[1])
        return undefined;
    const anchor = join(root, parts[0], parts[1]), file = join(anchor, META);
    try {
        // A symbolic link must not make another folder's metadata describe this one.
        const [realRoot, realAnchor, realFile] = await Promise.all([root, anchor, file].map(p => realpath(p)));
        if (!under(realRoot, realAnchor) || !under(realAnchor, realFile) || (await stat(realFile)).size > MAX_META_BYTES)
            return undefined;
        const meta = JSON.parse(await readFile(realFile, 'utf8'));
        const port = meta?.port ?? 22;
        if (typeof meta?.host !== 'string' || !meta.host || typeof meta.username !== 'string' || !meta.username)
            return undefined;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
            return undefined;
        if (typeof meta.remotePath !== 'string' || !meta.remotePath.startsWith('/'))
            return undefined;
        return {
            host: meta.host, username: meta.username, port, remotePath: normalizeRemotePath(posix.join(meta.remotePath, ...parts.slice(2))),
            ...(typeof meta.alias === 'string' && meta.alias ? { alias: meta.alias } : {}),
        };
    }
    catch {
        return undefined;
    }
}
