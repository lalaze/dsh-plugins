import { type RemoteWorkspace } from '../core/domain.js';
import type { WorkspaceHosts } from './hosts.js';
import { sshEndpoint, type Endpoint, type WorkspaceAccess } from '../core/access.js';
/** dsh-remote's POSIX normalization: `.` and `..` segments resolve lexically. */
export declare function normalizeRemotePath(path: string): string;
/** dsh-remote's 32-bit string hash, which separates folders whose basenames are equal. */
export declare function shortHash(value: string): string;
/**
 * Anchor folders a remote directory may use, in dsh-remote's order: the basename, then basename-hash.
 * Names that fit one path segment match dsh-remote's; longer ones, which dsh-remote cannot create, are shortened.
 */
export declare function anchorCandidates(home: string, endpoint: Endpoint, path: string): string[];
/** Create or reuse the local folder DSH adopts as the workspace for `remote` on `endpoint`. */
export declare function ensureAnchor(home: string, endpoint: Endpoint, remote: string): Promise<string>;
/** Remote directories adopted as DSH workspaces, anchored by dsh-remote-compatible local folders. */
export declare class RemoteWorkspaces {
    private readonly machines;
    private readonly access;
    private readonly options;
    constructor(machines: WorkspaceHosts, access: WorkspaceAccess, options?: {
        home?: string;
        endpoint?: typeof sshEndpoint;
    });
    /** Canonicalize the directory on the verified host, then create or reuse its anchor. */
    create(hostId: string, path: string, signal?: AbortSignal): Promise<RemoteWorkspace>;
}
