import { type AssetDetail, type ProjectStatus, type ScanResult, type ScannedAsset, type TabMode } from './domain.js';
import { type Failure } from './manage.js';
type FullScan = ScanResult<ScannedAsset>;
import { type Rules } from './scan.js';
export declare class AssetError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
/** Folder names the client may switch: at most 500, each a plain name with two booleans. */
export declare function parseRules(value: unknown): Rules;
export declare class AssetService {
    private readonly cwdOf;
    private readonly scanner;
    private readonly settings;
    private readonly results;
    private readonly running;
    private readonly libraries;
    /** Engines found lately, so a tab switch does not read the workspace's manifests again. */
    private readonly engines;
    constructor(cwdOf: (sessionId: string) => Promise<string | undefined>, settingsFile: string);
    /** The conversation's workspace folder, with symbolic links resolved. */
    root(sessionId: string): Promise<string>;
    /**
     * Whether a conversation's workspace gets the Assets tab: the user's choice for it, or else whether it declares a
     * game engine. A conversation without a local workspace is not a game project.
     */
    project(sessionId: string): Promise<ProjectStatus>;
    /** Shows or hides the tab for this workspace whatever is detected; null goes back to the detection. */
    setProject(sessionId: string, game: boolean | null): Promise<ProjectStatus>;
    mode(): Promise<TabMode>;
    setMode(mode: TabMode): Promise<TabMode>;
    private run;
    /** The last scan of the workspace, or a new one when there is none or `refresh` asks for it. */
    scan(sessionId: string, refresh?: boolean): Promise<FullScan>;
    /** The references to one image of the last scan. */
    detail(sessionId: string, path: string): Promise<AssetDetail>;
    /** Saves which top-level folders are read and, when given, where retired images go; then scans with them. */
    configure(sessionId: string, rules: Rules, retireDir?: unknown): Promise<FullScan>;
    /** A scan that started before a change must not be the answer to it. */
    private fresh;
    private library;
    /** The named images of the last scan that pass `allowed`; the rest are reported, never touched. */
    private chosen;
    /** Moves images of the last scan into the retired folder; only what the scan listed can be named. */
    retire(sessionId: string, paths: unknown): Promise<{
        moved: number;
        failed: Failure[];
        scan: FullScan;
    }>;
    /** Moves retired images back where they came from. */
    restore(sessionId: string, paths: unknown): Promise<{
        moved: number;
        failed: Failure[];
        scan: FullScan;
    }>;
    /** Adds and removes tags on images of the last scan, in the workspace's tag file. */
    tag(sessionId: string, paths: unknown, add: unknown, remove: unknown): Promise<{
        tags: Record<string, string[]>;
    }>;
    /** Sets or clears the note of one image of the last scan. */
    note(sessionId: string, path: unknown, note: unknown): Promise<{
        note: string;
    }>;
    /** An image's bytes. The path is relative to the workspace; symbolic links may not lead outside it. */
    raw(sessionId: string, path: string): Promise<Buffer>;
}
export {};
