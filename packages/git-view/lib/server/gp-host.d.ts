import { type GitPanelConfig, type SnapshotDeps } from './gp/host/core.js';
import { type SubprocessLike } from './gp/host/git.js';
import { type RemoteWorkspaces } from './runner.js';
/**
 * The host half of the Git panel ported from dsh-git-panel (see THIRD_PARTY_NOTICES.md), served on `/api/git-view/gp`.
 * Its commands and file reads go through a `SnapshotDeps` built per request: on this machine through DSH's subprocess
 * service and the file system, and in a Remote Agents workspace through that plugin's verified SSH Git batches and
 * file operations, so the same panel works on the remote repository instead of the local anchor folder.
 */
export interface PanelHostOptions {
    cwdOf(sessionId: string): Promise<string | undefined>;
    isRemoteCwd(cwd: string): boolean;
    subprocess: SubprocessLike;
    /** The Git executable, as git-view resolves it. */
    git(): Promise<string>;
    /** `-c` options before every local command, such as saved HTTPS credentials. */
    gitConfig(): Promise<string[]>;
    remote(): RemoteWorkspaces | undefined;
    get(name: string): unknown;
    /** The plugin's configuration; volatile fields are read again on every request. */
    config: unknown;
}
export declare class PanelHost {
    private readonly options;
    private readonly localRoots;
    private readonly localMisses;
    private readonly remoteCaches;
    constructor(options: PanelHostOptions);
    config(): GitPanelConfig;
    /** What the panel's functions need for one conversation: local, or its verified remote workspace. */
    deps(sessionId: string, signal?: AbortSignal): Promise<SnapshotDeps & {
        remote: boolean;
    }>;
    call(method: unknown, request: unknown, signal?: AbortSignal): Promise<unknown>;
}
/** Set from package.json by the server entry. */
export declare let VERSION: string;
export declare const setVersion: (version: string) => void;
/** `POST /api/git-view/gp` with `{ method, request }`; answers `{ ok: true, value }` as the panel's RPC envelope did. */
export declare function panelHandler(host: PanelHost, log?: (message: string) => void): (request: Request) => Promise<Response>;
