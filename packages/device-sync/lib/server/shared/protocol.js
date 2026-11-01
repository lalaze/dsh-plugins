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
/** Workspace reference unique across machines. */
export const workspaceRef = (deviceId, workspaceId) => `${deviceId}:${workspaceId}`;
export const parseWorkspaceRef = (ref) => {
    const at = ref.indexOf(':');
    return at > 0 && at < ref.length - 1 ? { deviceId: ref.slice(0, at), workspaceId: ref.slice(at + 1) } : undefined;
};
