import { type AssetDetail, type GeneratedImage, type ProjectStatus, type ScanResult, type ScannedAsset, type SourcesAnswer, type TabMode } from './domain.js';
import { type Failure, type Placed } from './manage.js';
import { type RemoteMachines } from './remote.js';
import { type Rules } from './scan.js';
import { AssetError, type ReadAnswer } from './workspace.js';
type FullScan = ScanResult<ScannedAsset>;
export { AssetError };
/** Folder names the client may switch: at most 500, each a plain name with two booleans. */
export declare function parseRules(value: unknown): Rules;
type MoveAnswer = {
    moved: number;
    failed: Failure[];
    scan: FullScan;
};
export interface ServiceOptions {
    /** Remote Agents' machines service when that plugin is installed; asked for at each use, as it may load later. */
    machines?: () => RemoteMachines | undefined;
    /** The bundled script that runs on a remote machine. */
    remoteScript?: () => Promise<string>;
    /** How image APIs are reached; tests answer for them. */
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}
export declare class AssetService {
    private readonly cwdOf;
    private readonly options;
    private readonly scanner;
    private readonly settings;
    private readonly sourceStore;
    private readonly results;
    private readonly running;
    private readonly libraries;
    /** Engines found lately, so a tab switch does not read the workspace's manifests again. */
    private readonly engines;
    private readonly reads;
    /** Image sources and their keys sit beside the settings, in a file of their own that only its owner may read. */
    constructor(cwdOf: (sessionId: string) => Promise<string | undefined>, settingsFile: string, options?: ServiceOptions);
    private library;
    /** The conversation's workspace: a folder on this computer, or one on the machine Remote Agents keeps it on. */
    private workspace;
    /**
     * Whether a conversation's workspace gets the Assets tab: the user's choice for it, or else whether it declares a
     * game engine. A conversation without a workspace this plugin can reach is not a game project.
     */
    project(sessionId: string): Promise<ProjectStatus>;
    /** Shows or hides the tab for this workspace whatever is detected; null goes back to the detection. */
    setProject(sessionId: string, game: boolean | null): Promise<ProjectStatus>;
    mode(): Promise<TabMode>;
    setMode(mode: TabMode): Promise<TabMode>;
    private run;
    /** A scan that started before a change must not be the answer to it. */
    private fresh;
    private last;
    /** The last scan of the workspace, or a new one when there is none or `refresh` asks for it. */
    scan(sessionId: string, refresh?: boolean): Promise<FullScan>;
    /** The references to one image of the last scan. */
    detail(sessionId: string, path: string): Promise<AssetDetail>;
    /** Saves which top-level folders are read and, when given, where retired images go; then scans with them. */
    configure(sessionId: string, rules: Rules, retireDir?: unknown): Promise<FullScan>;
    /** The named images of the last scan that pass `allowed`; the rest are reported, never touched. */
    private chosen;
    private move;
    /** Moves images of the last scan into the retired folder; only what the scan listed can be named. */
    retire(sessionId: string, paths: unknown): Promise<MoveAnswer>;
    /** Moves retired images back where they came from. */
    restore(sessionId: string, paths: unknown): Promise<MoveAnswer>;
    /** Adds and removes tags on images of the last scan, in the workspace's tag file. */
    tag(sessionId: string, paths: unknown, add: unknown, remove: unknown): Promise<{
        tags: Record<string, string[]>;
    }>;
    /** Sets or clears the note of one image of the last scan. */
    note(sessionId: string, path: unknown, note: unknown): Promise<{
        note: string;
    }>;
    /** Several images at once, as a grid asks for its thumbnails: one run on a remote machine instead of one per image. */
    images(sessionId: string, paths: unknown): Promise<ReadAnswer[]>;
    /** An image's bytes. The path is relative to the workspace; symbolic links may not lead outside it. */
    raw(sessionId: string, path: string): Promise<Buffer>;
    sources(): Promise<SourcesAnswer>;
    saveSource(source: unknown): Promise<SourcesAnswer & {
        id: string;
    }>;
    deleteSource(id: unknown): Promise<SourcesAnswer>;
    setDefaultSource(id: unknown): Promise<SourcesAnswer>;
    /**
     * Asks an image source for one picture, with images of the last scan as references. Nothing is written: the picture
     * comes back for the user to look at, and `save` puts it in the workspace.
     */
    generate(sessionId: string, input: {
        sourceId?: unknown;
        prompt?: unknown;
        references?: unknown;
        aspect?: unknown;
        transparent?: unknown;
    }, signal?: AbortSignal): Promise<GeneratedImage>;
    /**
     * Writes a picture to the workspace. A new path must be free and outside the retired folder; `replace` takes the place
     * of an image of the last scan, which is retired first and can be restored.
     */
    save(sessionId: string, path: unknown, data: unknown, replace: unknown): Promise<Placed & {
        scan: FullScan;
    }>;
}
