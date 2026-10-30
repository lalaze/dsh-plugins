/** Map a hostname to a known-host kind (self-hosted / unknown → 'other'). */
export function classifyHost(host) {
    const h = host.toLowerCase();
    if (h === 'github.com' || h.endsWith('.github.com'))
        return 'github';
    if (h === 'gitlab.com' || h.endsWith('.gitlab.com'))
        return 'gitlab';
    if (h === 'gitee.com' || h.endsWith('.gitee.com'))
        return 'gitee';
    if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org'))
        return 'bitbucket';
    return 'other';
}
/** Strip a trailing `.git` and any surrounding slashes from a repo path. */
function normalizePath(path) {
    return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}
/**
 * Extract `{ host, path }` from a remote URL, or null when it is not a
 * recognizable network URL (e.g. a bare local path `/srv/repo.git`). Any
 * userinfo (`user` / `user:token`) is dropped.
 */
function splitHostPath(raw) {
    const url = raw.trim();
    if (url === '')
        return null;
    // scp-like syntax: [user@]host:path (no scheme, no slash before the colon).
    const scp = url.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
    if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        const host = scp[1];
        const path = normalizePath(scp[2]);
        return host !== '' && path !== '' ? { host, path } : null;
    }
    // scheme://[user[:pass]@]host[:port]/path  (ssh, https, http, git, ssh+git…).
    const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)\/(.+)$/i);
    if (scheme !== null) {
        let authority = scheme[1];
        const at = authority.lastIndexOf('@');
        if (at >= 0)
            authority = authority.slice(at + 1);
        const host = authority.replace(/:\d+$/, '');
        const path = normalizePath(scheme[2]);
        return host !== '' && path !== '' ? { host, path } : null;
    }
    return null;
}
/** Build a {@link GitRemote} from a remote name + its configured URL. */
export function parseRemote(name, url) {
    const parsed = splitHostPath(url);
    if (parsed === null) {
        return { name, url, webUrl: null, host: null, hostKind: 'other' };
    }
    return {
        name,
        url,
        webUrl: `https://${parsed.host}/${parsed.path}`,
        host: parsed.host,
        hostKind: classifyHost(parsed.host),
    };
}
