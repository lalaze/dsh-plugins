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
/** Images one `images` request may name, and the bytes one answer carries at most; the rest are answered 413. */
export const IMAGE_BATCH = 64, IMAGE_BATCH_BYTES = 24 * 1024 * 1024;
/** References kept per image; `refCount` still counts all of them. */
export const REF_LIMIT = 8;
/** Images one scan reports; a workspace with more is reported as truncated. */
export const ASSET_LIMIT = 30000;
export const extensionOf = (path) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? '';
export const isImage = (path) => IMAGE_EXTENSIONS.includes(extensionOf(path));
/** The longest prompt kept with a picture. */
export const MADE_PROMPT_LIMIT = 2000;
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
export const SOURCE_KINDS = ['codex', 'openai', 'gemini'];
/** Kinds that call an HTTP API with a key, from the DSH host; the others run where the workspace is. */
export const usesApi = (kind) => kind !== 'codex';
/** What a new source of each kind starts with, and models to offer while typing. */
export const SOURCE_DEFAULTS = {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', models: ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini'] },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image', models: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image'] },
    // Codex draws with its own image tool; the model only drives it, and Codex's default is used when it is empty.
    codex: { baseUrl: '', model: '', models: [] },
};
/** The API shape nearest an image's own. */
export function aspectOf(width, height) {
    if (!width || !height)
        return 'square';
    return width / height > 1.2 ? 'wide' : height / width > 1.2 ? 'tall' : 'square';
}
/** Images one generation may be given as references. */
export const REFERENCE_LIMIT = 4;
/** Formats the image APIs take as references, and the ones a saved picture may have. */
export const REFERENCE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg'];
export const isReference = (path) => REFERENCE_EXTENSIONS.includes(extensionOf(path));
/** The longest prompt a generation takes. */
export const PROMPT_LIMIT = 8000;
/** Images one h3 batch redraw may take, and the smallest batch that pays off a VM boot without warning. */
export const H3_BATCH_LIMIT = 20;
export const H3_WORTH_IT = 4;
export const H3_MADE = { source: 'h3', model: 'MiniMax-H3-Image' };
/** Formats an h3 batch takes: the reference formats, and GIF, which the page turns into a PNG sheet first. */
export const isBatchSource = (path) => isReference(path) || extensionOf(path) === 'gif';
export const SHEET_BANDS_LIMIT = 12;
export const SHEET_GUTTER_LIMIT = 256;
export function isSpriteSheet(value) {
    const sheet = value;
    return !!sheet && typeof sheet === 'object' && typeof sheet.key === 'string' && /^#[0-9a-f]{6}$/.test(sheet.key)
        && Number.isInteger(sheet.bands) && sheet.bands >= 1 && sheet.bands <= SHEET_BANDS_LIMIT
        && Number.isInteger(sheet.gutter) && sheet.gutter >= 0 && sheet.gutter <= SHEET_GUTTER_LIMIT;
}
/** What h3 is told besides the user's prompt about a sprite sheet the page prepared. */
export function sheetHint(sheet) {
    return [
        `<Picture 1> is game sprite art on a flat ${sheet.key} background.`,
        'Keep its exact layout: every figure and object stays in the same place, at the same size and in the same pose, with nothing added or removed.',
        sheet.bands > 1 ? `The ${sheet.bands} rows are separate strips; keep the empty bands between them empty.` : '',
        `Leave all empty space flat solid ${sheet.key}, with no shadow, gradient or texture, and never use that colour inside a figure.`,
    ].filter(Boolean).join(' ');
}
export const isBatchRunning = (phase) => phase === 'booting' || phase === 'drawing' || phase === 'stopping';
/**
 * In the workspace: the image source agents working in the project generate with, and the script they run for it.
 * Committed with the project; it never holds a key.
 */
export const PROJECT_DIR = '.game-assets';
export const PROJECT_SOURCE_FILE = `${PROJECT_DIR}/image-source.json`;
export const PROJECT_SCRIPT = `${PROJECT_DIR}/generate-image.cjs`;
export const PROJECT_README = `${PROJECT_DIR}/README.md`;
/** Agent instruction files that get a short section on generating images. */
export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'];
/** On the machine the project is on, under the user's home: keys of the sources projects there use, readable by the user alone. */
export const KEYS_DIR = '.dsh-game-assets', KEYS_FILE = 'keys.json';
