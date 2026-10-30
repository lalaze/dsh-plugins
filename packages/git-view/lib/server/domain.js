/** Browser-safe contracts of the Git routes. Paths are POSIX, relative to the repository root unless said otherwise. */
/** Files compared and edited in the diff view. */
export const TEXT_LIMIT = 4 * 1024 * 1024;
/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-Git-View';
/** Conversations whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;
