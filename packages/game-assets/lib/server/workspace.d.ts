import { type Aspect, type ImageAnswer, type ProjectSourceStatus, type ScanResult, type ScannedAsset } from './domain.js';
import type { Library, Making, Moved, Placed } from './manage.js';
import { type ProjectBundle } from './project.js';
import type { Rules, Scanner } from './scan.js';
export declare class AssetError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export type WorkspaceRequest = {
    op: 'scan';
    rules: Rules;
    retireDir: string;
} | {
    op: 'detect';
} | {
    op: 'retire' | 'restore';
    retireDir: string;
    paths: string[];
} | {
    op: 'tag';
    paths: string[];
    add: string[];
    remove: string[];
} | {
    op: 'note';
    path: string;
    note: string;
} | {
    op: 'read';
    paths: string[];
}
/**
 * Writes a picture to `path`, replacing the image there if `replace`. Its bytes come in `data` (base64) or, on a remote
 * machine, were uploaded beforehand to `staged`, relative to the workspace, with the digest `sha256`.
 */
 | {
    op: 'place';
    path: string;
    replace: boolean;
    retireDir: string;
    data?: string;
    staged?: string;
    sha256?: string;
    made?: Making;
}
/** Brings the retired image `path` back where it came from, retiring the image there first. */
 | {
    op: 'revert';
    path: string;
    retireDir: string;
}
/** Generates a picture with the Codex CLI signed in on this machine; `references` are workspace paths. */
 | {
    op: 'codex';
    prompt: string;
    references: string[];
    aspect: Aspect;
    transparent: boolean;
    model?: string;
    loginShell?: boolean;
} | {
    op: 'projectSource';
}
/** Records an image source for the project's agents, or removes it with `bundle: null`. A remote bundle comes `staged`. */
 | {
    op: 'setProjectSource';
    bundle?: ProjectBundle | null;
    staged?: string;
    sha256?: string;
};
/** The picture of a `codex` request, its bytes in base64. */
export interface CodexAnswer {
    data: string;
    mediaType: string;
    width?: number;
    height?: number;
    text?: string;
}
export type ReadAnswer = ImageAnswer;
export interface WorkspaceAnswers {
    scan: ScanResult<ScannedAsset>;
    detect: {
        engine: string | null;
    };
    retire: Moved;
    restore: Moved;
    tag: Record<string, string[]>;
    note: {
        note: string;
    };
    read: ReadAnswer[];
    place: Placed;
    revert: Placed;
    codex: CodexAnswer;
    projectSource: ProjectSourceStatus;
    setProjectSource: ProjectSourceStatus;
}
/** What a request may be given besides itself, in the process that runs it. */
export interface HandleExtras {
    signal?: AbortSignal;
    codexCommand?: string;
}
/** Where Remote Agents' upload leaves a picture on a remote machine before the script puts it in place. */
export declare const STAGING_DIR = ".dsh-remote-agents/attachments/game-assets";
/** An image's bytes. The path is relative to the workspace `root`; symbolic links may not lead outside it. */
export declare function readImage(root: string, path: string): Promise<Buffer>;
/** Answers one request about the folder `root`, an existing directory with symbolic links resolved. */
export declare function handle(root: string, request: WorkspaceRequest, scanner: Scanner, library: Library, extras?: HandleExtras): Promise<unknown>;
