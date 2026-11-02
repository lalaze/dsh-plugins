/**
 * Vocabulary shared by the host and the browser client, and by two paired hosts. Browser-safe: no Node imports.
 *
 * Every session has one executing machine, the one whose DSH owns it. Only that machine appends to the session; a
 * paired machine keeps a read-only copy (a mirror) and sends it requests: prompt, stop, answer. Mirrors never enter
 * DSH's own session store, so nothing synced can make an agent run again.
 */
/** Browser route on each host: GET returns {@link LocalStatus}; POST runs one {@link LocalAction}. */
export const LOCAL_ROUTE = '/api/device-sync';
/** Browser route streaming one mirrored session live, as newline-delimited {@link LiveFrame}s. */
export const LIVE_ROUTE = '/api/device-sync/live';
/** Browser route serving one mirrored attachment's bytes. */
export const ATTACHMENT_ROUTE = '/api/device-sync/attachment';
/** Version of the host-to-host protocol; a peer with another major version is refused. */
export const PROTOCOL_VERSION = 1;
/** Default port of the host-to-host listener, bound to this machine's Tailscale address. */
export const DEFAULT_PORT = 47630;
export const DEFAULT_GRANTS = { history: true, command: false };
/** POSIX normalization as remote-agents applies it: `.` and `..` segments resolve lexically, trailing slashes go. */
export function normalizeRemotePath(path) {
    const parts = [];
    for (const segment of path.split('/')) {
        if (!segment || segment === '.')
            continue;
        if (segment === '..')
            parts.pop();
        else
            parts.push(segment);
    }
    return `/${parts.join('/')}`;
}
const normalizeHost = (host) => host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
/** Whether a binding, possibly from the paired machine, has every field it needs. */
export const isRemoteBinding = (value) => typeof value?.host === 'string' && value.host !== ''
    && typeof value.username === 'string' && value.username !== '' && Number.isInteger(value.port)
    && typeof value.remotePath === 'string' && value.remotePath.startsWith('/');
/**
 * Whether two remote workspaces are the same project: the same host, user, port and directory. Bindings arrive from
 * the paired machine, so anything malformed matches nothing.
 */
export function sameRemote(a, b) {
    return isRemoteBinding(a) && isRemoteBinding(b) && normalizeHost(a.host) === normalizeHost(b.host) && a.username === b.username
        && a.port === b.port && normalizeRemotePath(a.remotePath) === normalizeRemotePath(b.remotePath);
}
/** A binding as one line, such as `ssh://me@mac-mini:2222/home/me/project`. */
export const remoteLabel = (remote) => `ssh://${remote.username}@${remote.host.includes(':') && !remote.host.startsWith('[') ? `[${remote.host}]` : remote.host}${remote.port === 22 ? '' : `:${remote.port}`}${remote.remotePath}`;
/** The first of `local` that is the same SSH directory as `remote`. */
export const matchingWorkspace = (remote, local) => remote ? local.find(workspace => sameRemote(workspace.remote, remote)) : undefined;
/** Workspace reference unique across machines. */
export const workspaceRef = (deviceId, workspaceId) => `${deviceId}:${workspaceId}`;
export const parseWorkspaceRef = (ref) => {
    const at = ref.indexOf(':');
    return at > 0 && at < ref.length - 1 ? { deviceId: ref.slice(0, at), workspaceId: ref.slice(at + 1) } : undefined;
};
