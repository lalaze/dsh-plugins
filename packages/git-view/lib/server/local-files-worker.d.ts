export type LocalFileCheckpoint = 'directory-observed' | 'directory-bound' | 'file-opened' | 'temporary-written' | 'before-commit';
/** Test seam at real asynchronous boundaries. Never populated from an HTTP request. */
export interface LocalFileOptions {
    checkpoint?(stage: LocalFileCheckpoint): Promise<void> | void;
}
export interface LocalFileRequest {
    action: 'read' | 'write';
    root: string;
    file: string;
    requested: string;
    rootIdentity: {
        dev: string;
        ino: string;
    };
    limit: number;
    content?: string;
    revision?: string;
}
/** Runs the worker with a bounded lifetime and without shell interpolation or host-global working-directory changes. */
export declare function localFileOperation<T>(request: LocalFileRequest, options: LocalFileOptions, signal?: AbortSignal): Promise<T>;
