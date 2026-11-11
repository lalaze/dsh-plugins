/** Shared by the host half and the client: the route, its limits, and what a scan reports. */
export const ROUTE = '/api/game-assets';
/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-Game-Assets';
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;
export const IMAGE_EXTENSIONS = ['png', 'gif', 'webp', 'jpg', 'jpeg', 'svg'];
export const IMAGE_TYPES = {
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
};
/** Images served for previews; larger files are listed without a picture. */
export const RAW_LIMIT = 32 * 1024 * 1024;
/** References kept per image; `refCount` still counts all of them. */
export const REF_LIMIT = 8;
/** Images one scan reports; a workspace with more is reported as truncated. */
export const ASSET_LIMIT = 30000;
export const extensionOf = (path) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? '';
export const isImage = (path) => IMAGE_EXTENSIONS.includes(extensionOf(path));
export const DEFAULT_RETIRE_DIR = '_retired';
/** In the retired folder: where each retired image came from. */
export const RETIRED_LIST = 'retired.json';
/** In the workspace folder: tags and notes by image path, meant to be committed with the project. */
export const TAGS_FILE = '.game-assets.json';
/** The longest note a request may carry; what is kept is cut to the note limit. */
export const NOTE_LIMIT_HINT = 4000;
/** Images one retire, restore or tag request may name. */
export const SELECTION_LIMIT = 5000;
/** Top-level folders left out until the user includes them: build output, reports and screenshots. */
export const DEFAULT_OFF = new Set(['dist', 'build', 'out', 'coverage', 'docs', 'doc', 'artifacts', 'screenshots', 'reports', 'logs', 'test-results',
    'playwright-report', 'tmp', 'temp', 'target', 'bin', 'obj', 'Library', 'Temp', 'Logs', 'vendor']);
/**
 * What a folder is read for until the user says otherwise. Build output is skipped. A folder that is nearly all images
 * and holds a sliver of the project's code is an art folder: scripts in it are generator output that lists every image
 * beside it, so they are not counted as code.
 */
export function defaultRule(name, images = 0, codeFiles = 0, allCodeFiles = 0) {
    if (DEFAULT_OFF.has(name))
        return { assets: false, code: false };
    const artFolder = images >= 50 && images > codeFiles * 50 && codeFiles * 10 < allCodeFiles;
    return { assets: true, code: !artFolder };
}
/** Images and code directly in the workspace folder are listed under this name. */
export const ROOT_FOLDER = '.';
