import { type WorkingFile } from './domain.js';
import { type LocalFileOptions } from './local-files-worker.js';
import { type RemoteTarget, type RemoteWorkspaces } from './runner.js';
/** The working-tree files the diff view compares and saves; paths are relative to the workspace folder. */
export interface WorkspaceFiles {
    read(path: string, signal: AbortSignal): Promise<WorkingFile>;
    /** Replaces the file read at `revision`; a file changed since is refused. */
    write(path: string, content: string, revision: string, signal: AbortSignal): Promise<{
        revision: string;
    }>;
}
/** UTF-8 without NUL bytes. A BOM stays in the text, so saving keeps it. */
export declare function textOf(data: Uint8Array): string | undefined;
export declare function workspacePath(value: unknown): string;
/**
 * Files of a local workspace. Operations use an isolated, directory-bound worker so swapped parent paths cannot
 * redirect data I/O. Revision and identity checks detect intervening changes; atomic rename is not cross-process CAS.
 */
export declare class LocalFiles implements WorkspaceFiles {
    private readonly root;
    private readonly options;
    private static readonly saving;
    constructor(root: string, options?: LocalFileOptions);
    private request;
    read(path: string, signal?: AbortSignal): Promise<WorkingFile>;
    write(path: string, content: string, revision: string, signal?: AbortSignal): Promise<{
        revision: string;
    }>;
}
/** Files of a remote workspace, through Remote Agents' revision-checked transfers. */
export declare class RemoteFiles implements WorkspaceFiles {
    private readonly service;
    private readonly sessionId;
    private readonly target?;
    constructor(service: RemoteWorkspaces, sessionId: string, target?: RemoteTarget | undefined);
    read(path: string, signal: AbortSignal): Promise<WorkingFile>;
    write(path: string, content: string, revision: string, signal: AbortSignal): Promise<{
        revision: string;
    }>;
}
