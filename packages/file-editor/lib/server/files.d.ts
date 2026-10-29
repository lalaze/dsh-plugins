/** Text the editor loads and saves; larger files can still be previewed by DSH. */
export declare const TEXT_LIMIT: number;
/** Raw bytes served for previews. */
export declare const RAW_LIMIT: number;
/** Workspaces whose files live on another machine: a local anchor folder under `remote-workspaces`. */
export declare const REMOTE_ANCHOR: RegExp;
export declare class FileError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
export interface FileState {
    path: string;
    size: number;
    mtimeMs: number;
}
export type ReadResult = FileState & ({
    kind: 'text';
    content: string;
    revision: string;
} | {
    kind: 'binary';
    revision: string;
} | {
    kind: 'large';
    revision?: undefined;
});
/** Files of local workspaces, reached only through a conversation's working directory. */
export declare class LocalFiles {
    private readonly cwdOf;
    private readonly saving;
    constructor(cwdOf: (sessionId: string) => Promise<string | undefined>);
    /** A path relative to the workspace, or absolute inside it; symbolic links may not lead outside. */
    resolve(sessionId: string, path: string): Promise<{
        file: string;
        display: string;
    }>;
    private regular;
    stat(sessionId: string, path: string): Promise<FileState>;
    read(sessionId: string, path: string): Promise<ReadResult>;
    raw(sessionId: string, path: string): Promise<Buffer>;
    /** Replace a file read at `revision`, atomically and keeping its permissions; a file changed since is refused. */
    write(sessionId: string, path: string, content: string, revision: string): Promise<FileState & {
        revision: string;
    }>;
}
