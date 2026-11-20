/** Shared by the host half and the client: the route, what a status says, and what the tab is told. */
export const ROUTE = '/api/project-status';
/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-Project-Status';
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;
/** What is written down about one goal, besides its name and its steps. */
export const PARTS = ['progress', 'blockers', 'next'];
/** Characters one text may hold; a status is a few lines, not a document. */
export const FIELD_LIMIT = 8000;
export const TITLE_LIMIT = 300;
/** More goals than this in one project is a backlog, which belongs in a tracker. */
export const GOAL_LIMIT = 100;
/** A status file larger than this was not written as one; it is refused rather than loaded into every poll. */
export const FILE_LIMIT = 256 * 1024;
/** The revision of a status nobody has written yet. */
export const NO_REVISION = 'none';
