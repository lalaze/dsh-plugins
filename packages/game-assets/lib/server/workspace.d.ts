import { type ImageAnswer, type ScanResult, type ScannedAsset } from './domain.js';
import type { Library, Moved } from './manage.js';
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
};
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
}
/** An image's bytes. The path is relative to the workspace `root`; symbolic links may not lead outside it. */
export declare function readImage(root: string, path: string): Promise<Buffer>;
/** Answers one request about the folder `root`, an existing directory with symbolic links resolved. */
export declare function handle(root: string, request: WorkspaceRequest, scanner: Scanner, library: Library): Promise<unknown>;
