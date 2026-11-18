/** Shared by the host half and the client: the route, its limits, and what a scan reports. */

export const ROUTE = '/api/game-assets';
/** Sent by the client; links, forms and images from other pages cannot add it. */
export const CLIENT_HEADER = 'X-DSH-Game-Assets';
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export const REMOTE_ANCHOR = /(?:^|[/\\])remote-workspaces(?:[/\\]|$)/;

export const IMAGE_EXTENSIONS = ['png', 'gif', 'webp', 'jpg', 'jpeg', 'svg'] as const;
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml',
};
/** Images served for previews; larger files are listed without a picture. */
export const RAW_LIMIT = 32 * 1024 * 1024;
/** Images one `images` request may name, and the bytes one answer carries at most; the rest are answered 413. */
export const IMAGE_BATCH = 64, IMAGE_BATCH_BYTES = 24 * 1024 * 1024;
/** One image of an `images` request: its bytes in base64, or why it could not be read. */
export interface ImageAnswer { path: string; data?: string; error?: string; status?: number }
/** References kept per image; `refCount` still counts all of them. */
export const REF_LIMIT = 8;
/** Images one scan reports; a workspace with more is reported as truncated. */
export const ASSET_LIMIT = 30000;

export const extensionOf = (path: string): string => /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? '';
export const isImage = (path: string): boolean => (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(path));

/**
 * How the code refers to an image:
 * - `path`: a literal path, or a file name only one image has;
 * - `name`: a bare name that several images share, or the name without its extension;
 * - `pattern`: a path built at run time, such as `cats/${breed}-idle.png`;
 * - `folder`: a folder literal such as `'art/cats/'`, from which paths are joined.
 */
export type ReferenceKind = 'path' | 'name' | 'pattern' | 'folder';
export interface Reference { file: string; line: number; text: string; kind: ReferenceKind }
/** `used` has a literal reference; `maybe` only an ambiguous or computed one; `unused` none at all. */
export type Usage = 'used' | 'maybe' | 'unused';

export interface Asset {
  /** Relative to the workspace, with `/` separators. */
  path: string;
  size: number;
  mtimeMs: number;
  width?: number;
  height?: number;
  usage: Usage;
  refCount: number;
  /** Shared by byte-identical files. */
  dup?: number;
  /** A {@link VersionFamily} this image belongs to, and its version there. */
  family?: string;
  version?: string;
  /** In the retired folder: out of the game's way, not matched against code. */
  retired?: true;
  /** Where a retired image came from, when the retired list recorded it; such an image can be restored. */
  origin?: string;
  tags?: string[];
  note?: string;
  /** How the picture was made, when the plugin or the project's script generated it. */
  made?: MadeInfo;
  /** When a retired image was retired, from the retired list. */
  retiredAt?: string;
}
/**
 * How a picture was made, kept in the tag file under the picture's path and moved with the file when it is retired or
 * brought back, so an image's history can say where each version came from.
 */
export interface MadeInfo { at: string; source: string; model?: string; prompt: string; by?: 'agent' }
/** The longest prompt kept with a picture. */
export const MADE_PROMPT_LIMIT = 2000;

/** An image as the host keeps it: with the strongest references to it. A scan answers the plain {@link Asset}. */
export interface ScannedAsset extends Asset { refs: Reference[] }
/** What the `detail` action answers for one image. */
export interface AssetDetail { path: string; refs: Reference[]; refCount: number }

export interface VersionEntry { label: string; path: string; total: number; used: number; maybe: number; bytes: number }
/** Sibling folders that differ only in a version, such as `cast-v5` … `cast-v9`; oldest first. */
export interface VersionFamily { id: string; dir: string; name: string; versions: VersionEntry[] }

/** What the scan reads from a top-level folder: its images, and its code as a source of references. */
export interface FolderRule { assets: boolean; code: boolean }
export interface Folder extends FolderRule { name: string; images: number; codeFiles: number }

export interface ScanResult<A extends Asset = Asset> {
  /** The workspace folder's name. */
  root: string;
  scannedAt: number;
  durationMs: number;
  assets: A[];
  families: VersionFamily[];
  folders: Folder[];
  /** Code and data files read for references. */
  codeFiles: number;
  truncated: boolean;
  /** The folder retired images are moved to, relative to the workspace. */
  retireDir: string;
}
/** What retiring or restoring answers: how many images moved, which did not and why, and the workspace as it is now. */
export interface MoveResult { moved: number; failed: { path: string; error: string }[]; scan: ScanResult }
/** What going back to an earlier version answers: where it is now, where the image it replaced went, and the workspace. */
export interface RevertResult { path: string; retired?: string; scan: ScanResult }
/** What a tag change answers: the tags of each changed image afterwards. */
export interface TagResult { tags: Record<string, string[]> }

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
export function defaultRule(name: string, images = 0, codeFiles = 0, allCodeFiles = 0): FolderRule {
  if (DEFAULT_OFF.has(name)) return { assets: false, code: false };
  const artFolder = images >= 50 && images > codeFiles * 50 && codeFiles * 10 < allCodeFiles;
  return { assets: true, code: !artFolder };
}
/** Where the Assets tab appears: in game projects only, or in every conversation. */
export type TabMode = 'games' | 'all';
/** Whether a conversation's workspace gets the Assets tab. */
export interface ProjectStatus {
  /** The workspace folder's name; null for a conversation without a workspace the plugin can reach. */
  root: string | null;
  /** The machine a remote workspace is on, as Remote Agents labels it; null for a folder on this computer. */
  host: string | null;
  /** The game engine found in the workspace, if any. */
  engine: string | null;
  /** The user's choice for this workspace; null follows the detection. */
  override: boolean | null;
  /** The override, or else whether an engine was found. */
  game: boolean;
  mode: TabMode;
}
/** Images and code directly in the workspace folder are listed under this name. */
export const ROOT_FOLDER = '.';

/**
 * The kinds of image source: `openai` speaks OpenAI's Images API (`/images/generations` and `/images/edits`), as
 * OpenAI and most relay services do; `gemini` speaks Gemini's `generateContent`; `codex` runs the Codex CLI signed in
 * on the machine the workspace is on, with its own image tool and no key.
 */
export type SourceKind = 'openai' | 'gemini' | 'codex';
export const SOURCE_KINDS: readonly SourceKind[] = ['codex', 'openai', 'gemini'];
/** Kinds that call an HTTP API with a key, from the DSH host; the others run where the workspace is. */
export const usesApi = (kind: SourceKind): boolean => kind !== 'codex';
/** What a new source of each kind starts with, and models to offer while typing. */
export const SOURCE_DEFAULTS: Record<SourceKind, { baseUrl: string; model: string; models: string[] }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', models: ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini'] },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.1-flash-image', models: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image'] },
  // Codex draws with its own image tool; the model only drives it, and Codex's default is used when it is empty.
  codex: { baseUrl: '', model: '', models: [] },
};
/** A source as the client sees it: everything but the key, of which only the end is shown so keys can be told apart. */
export interface SourceView { id: string; name: string; kind: SourceKind; baseUrl: string; model: string; keyHint: string }
/** A source as the client sends it; an absent `apiKey` keeps the key already saved. */
export interface SourceInput { id?: string; name: string; kind: SourceKind; baseUrl: string; model: string; apiKey?: string }
export interface SourcesAnswer { sources: SourceView[]; defaultId: string | null }
/** The shape asked of a generated picture; the API's nearest size is used. */
export type Aspect = 'square' | 'wide' | 'tall';
/** The API shape nearest an image's own. */
export function aspectOf(width?: number, height?: number): Aspect {
  if (!width || !height) return 'square';
  return width / height > 1.2 ? 'wide' : height / width > 1.2 ? 'tall' : 'square';
}
/** What one generation answers: the picture as the API made it, in base64. */
export interface GeneratedImage { data: string; mediaType: string; width?: number; height?: number; model: string; source: string; ms: number; text?: string }
/** What saving a picture answers: where it went, where the image it replaced was retired to, and the workspace now. */
export interface SaveResult { path: string; retired?: string; scan: ScanResult }
/** Images one generation may be given as references. */
export const REFERENCE_LIMIT = 4;
/** Formats the image APIs take as references, and the ones a saved picture may have. */
export const REFERENCE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg'] as const;
export const isReference = (path: string): boolean => (REFERENCE_EXTENSIONS as readonly string[]).includes(extensionOf(path));
/** The longest prompt a generation takes. */
export const PROMPT_LIMIT = 8000;

/** Images one h3 batch redraw may take, and the smallest batch that pays off a VM boot without warning. */
export const H3_BATCH_LIMIT = 20;
export const H3_WORTH_IT = 4;
export const H3_MADE = { source: 'h3', model: 'MiniMax-H3-Image' } as const;
/** Formats an h3 batch takes: the reference formats, and GIF, which the page turns into a PNG sheet first. */
export const isBatchSource = (path: string): boolean => isReference(path) || extensionOf(path) === 'gif';

/**
 * How the page laid out a sprite for h3, which reads and draws opaque pictures only: see-through pixels became the flat
 * `key` colour, and a long strip was cut into `bands` equal parts stacked with `gutter` pixels of key colour between
 * them, so the sheet is near square. The page undoes both on the picture h3 returns.
 */
export interface SpriteSheet { key: string; bands: number; gutter: number }
export const SHEET_BANDS_LIMIT = 12;
export const SHEET_GUTTER_LIMIT = 256;
export function isSpriteSheet(value: unknown): value is SpriteSheet {
  const sheet = value as SpriteSheet | undefined;
  return !!sheet && typeof sheet === 'object' && typeof sheet.key === 'string' && /^#[0-9a-f]{6}$/.test(sheet.key)
    && Number.isInteger(sheet.bands) && sheet.bands >= 1 && sheet.bands <= SHEET_BANDS_LIMIT
    && Number.isInteger(sheet.gutter) && sheet.gutter >= 0 && sheet.gutter <= SHEET_GUTTER_LIMIT;
}
/** What h3 is told besides the user's prompt about a sprite sheet the page prepared. */
export function sheetHint(sheet: SpriteSheet): string {
  return [
    `<Picture 1> is game sprite art on a flat ${sheet.key} background.`,
    'Keep its exact layout: every figure and object stays in the same place, at the same size and in the same pose, with nothing added or removed.',
    sheet.bands > 1 ? `The ${sheet.bands} rows are separate strips; keep the empty bands between them empty.` : '',
    `Leave all empty space flat solid ${sheet.key}, with no shadow, gradient or texture, and never use that colour inside a figure.`,
  ].filter(Boolean).join(' ');
}

export type BatchPhase = 'booting' | 'drawing' | 'stopping' | 'done' | 'failed' | 'stopped';
export type BatchItemState = 'waiting' | 'drawing' | 'done' | 'failed' | 'skipped';
export interface BatchItemStatus {
  path: string;
  status: BatchItemState;
  error?: string;
  ms?: number;
  width?: number;
  height?: number;
  /** Set when the page sent this image as a prepared sprite sheet. */
  sheet?: SpriteSheet;
}
/**
 * How `h3 up` is getting on with finding a GPU: the GPUs it asks for in order, the polling round and minutes waited
 * while all are `busy`, the `gpu` it got with the time it got it (`since`, set by the host), and the `setupAttempt`
 * h3 is on after its connection to the VM dropped during setup (colab-use eb925c6).
 */
export interface BootProgress { gpus?: string[]; round?: number; waitedMinutes?: number; busy?: boolean; gpu?: string; since?: number; setupAttempt?: number }
export interface BatchStatus {
  id: string;
  sessionId: string;
  phase: BatchPhase;
  startedAt: number;
  prompt: string;
  items: BatchItemStatus[];
  error?: string;
  downError?: string;
  /** Set while `h3 up` looks for a GPU and after it got one. */
  boot?: BootProgress;
}
export interface BatchStatusAnswer {
  job: BatchStatus | null;
  busy: boolean;
}
export const isBatchRunning = (phase: BatchPhase): boolean => phase === 'booting' || phase === 'drawing' || phase === 'stopping';

/**
 * In the workspace: the image source agents working in the project generate with, and the script they run for it.
 * Committed with the project; it never holds a key.
 */
export const PROJECT_DIR = '.game-assets';
export const PROJECT_SOURCE_FILE = `${PROJECT_DIR}/image-source.json`;
export const PROJECT_SCRIPT = `${PROJECT_DIR}/generate-image.cjs`;
export const PROJECT_README = `${PROJECT_DIR}/README.md`;
/** Agent instruction files that get a short section on generating images. */
export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
/** On the machine the project is on, under the user's home: keys of the sources projects there use, readable by the user alone. */
export const KEYS_DIR = '.dsh-game-assets', KEYS_FILE = 'keys.json';
/** The image source recorded in a project, and the retired folder its script puts replaced images in. */
export interface ProjectSource { id: string; name: string; kind: SourceKind; model: string; baseUrl: string; retireDir?: string }
/** What a workspace records: its source, and the files that carry it. */
export interface ProjectSourceStatus { source: ProjectSource | null; files: string[] }
