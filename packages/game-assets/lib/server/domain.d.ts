/** Shared by the host half and the client: the route, its limits, and what a scan reports. */
export declare const ROUTE = "/api/game-assets";
/** Sent by the client; links, forms and images from other pages cannot add it. */
export declare const CLIENT_HEADER = "X-DSH-Game-Assets";
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export declare const REMOTE_ANCHOR: RegExp;
export declare const IMAGE_EXTENSIONS: readonly ["png", "gif", "webp", "jpg", "jpeg", "svg"];
export declare const IMAGE_TYPES: Record<string, string>;
/** Images served for previews; larger files are listed without a picture. */
export declare const RAW_LIMIT: number;
/** Images one `images` request may name, and the bytes one answer carries at most; the rest are answered 413. */
export declare const IMAGE_BATCH = 64, IMAGE_BATCH_BYTES: number;
/** One image of an `images` request: its bytes in base64, or why it could not be read. */
export interface ImageAnswer {
    path: string;
    data?: string;
    error?: string;
    status?: number;
}
/** References kept per image; `refCount` still counts all of them. */
export declare const REF_LIMIT = 8;
/** Images one scan reports; a workspace with more is reported as truncated. */
export declare const ASSET_LIMIT = 30000;
export declare const extensionOf: (path: string) => string;
export declare const isImage: (path: string) => boolean;
/**
 * How the code refers to an image:
 * - `path`: a literal path, or a file name only one image has;
 * - `name`: a bare name that several images share, or the name without its extension;
 * - `pattern`: a path built at run time, such as `cats/${breed}-idle.png`;
 * - `folder`: a folder literal such as `'art/cats/'`, from which paths are joined.
 */
export type ReferenceKind = 'path' | 'name' | 'pattern' | 'folder';
export interface Reference {
    file: string;
    line: number;
    text: string;
    kind: ReferenceKind;
}
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
}
/** An image as the host keeps it: with the strongest references to it. A scan answers the plain {@link Asset}. */
export interface ScannedAsset extends Asset {
    refs: Reference[];
}
/** What the `detail` action answers for one image. */
export interface AssetDetail {
    path: string;
    refs: Reference[];
    refCount: number;
}
export interface VersionEntry {
    label: string;
    path: string;
    total: number;
    used: number;
    maybe: number;
    bytes: number;
}
/** Sibling folders that differ only in a version, such as `cast-v5` … `cast-v9`; oldest first. */
export interface VersionFamily {
    id: string;
    dir: string;
    name: string;
    versions: VersionEntry[];
}
/** What the scan reads from a top-level folder: its images, and its code as a source of references. */
export interface FolderRule {
    assets: boolean;
    code: boolean;
}
export interface Folder extends FolderRule {
    name: string;
    images: number;
    codeFiles: number;
}
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
export interface MoveResult {
    moved: number;
    failed: {
        path: string;
        error: string;
    }[];
    scan: ScanResult;
}
/** What a tag change answers: the tags of each changed image afterwards. */
export interface TagResult {
    tags: Record<string, string[]>;
}
export declare const DEFAULT_RETIRE_DIR = "_retired";
/** In the retired folder: where each retired image came from. */
export declare const RETIRED_LIST = "retired.json";
/** In the workspace folder: tags and notes by image path, meant to be committed with the project. */
export declare const TAGS_FILE = ".game-assets.json";
/** The longest note a request may carry; what is kept is cut to the note limit. */
export declare const NOTE_LIMIT_HINT = 4000;
/** Images one retire, restore or tag request may name. */
export declare const SELECTION_LIMIT = 5000;
/** Top-level folders left out until the user includes them: build output, reports and screenshots. */
export declare const DEFAULT_OFF: Set<string>;
/**
 * What a folder is read for until the user says otherwise. Build output is skipped. A folder that is nearly all images
 * and holds a sliver of the project's code is an art folder: scripts in it are generator output that lists every image
 * beside it, so they are not counted as code.
 */
export declare function defaultRule(name: string, images?: number, codeFiles?: number, allCodeFiles?: number): FolderRule;
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
export declare const ROOT_FOLDER = ".";
/**
 * The kinds of image API a source may be: `openai` speaks OpenAI's Images API (`/images/generations` and
 * `/images/edits`), as OpenAI and most relay services do; `gemini` speaks Gemini's `generateContent`.
 */
export type SourceKind = 'openai' | 'gemini';
export declare const SOURCE_KINDS: readonly SourceKind[];
/** What a new source of each kind starts with, and models to offer while typing. */
export declare const SOURCE_DEFAULTS: Record<SourceKind, {
    baseUrl: string;
    model: string;
    models: string[];
}>;
/** A source as the client sees it: everything but the key, of which only the end is shown so keys can be told apart. */
export interface SourceView {
    id: string;
    name: string;
    kind: SourceKind;
    baseUrl: string;
    model: string;
    keyHint: string;
}
/** A source as the client sends it; an absent `apiKey` keeps the key already saved. */
export interface SourceInput {
    id?: string;
    name: string;
    kind: SourceKind;
    baseUrl: string;
    model: string;
    apiKey?: string;
}
export interface SourcesAnswer {
    sources: SourceView[];
    defaultId: string | null;
}
/** The shape asked of a generated picture; the API's nearest size is used. */
export type Aspect = 'square' | 'wide' | 'tall';
/** What one generation answers: the picture as the API made it, in base64. */
export interface GeneratedImage {
    data: string;
    mediaType: string;
    width?: number;
    height?: number;
    model: string;
    source: string;
    ms: number;
    text?: string;
}
/** What saving a picture answers: where it went, where the image it replaced was retired to, and the workspace now. */
export interface SaveResult {
    path: string;
    retired?: string;
    scan: ScanResult;
}
/** Images one generation may be given as references. */
export declare const REFERENCE_LIMIT = 4;
/** Formats the image APIs take as references, and the ones a saved picture may have. */
export declare const REFERENCE_EXTENSIONS: readonly ["png", "webp", "jpg", "jpeg"];
export declare const isReference: (path: string) => boolean;
/** The longest prompt a generation takes. */
export declare const PROMPT_LIMIT = 8000;
