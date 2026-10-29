import { type RemoteWorkspace } from '../core/domain.js';
import type { WorkspaceHosts } from './hosts.js';
import { sshEndpoint, type Endpoint, type WorkspaceAccess } from './access.js';
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
/** A remote workspace another DSH added on a shared host, with the local folder DSH adopts for it. */
export interface OfferedWorkspace {
    hostId: string;
    host: string;
    remotePath: string;
    path: string;
    by?: string;
}
/** Remote directories adopted as DSH workspaces, anchored by dsh-remote-compatible local folders. */
export declare class RemoteWorkspaces {
    private readonly machines;
    private readonly access;
    private readonly options;
    /** Offers handed to a client recently; another client open at the same time does not add them again. */
    private readonly offered;
    /** Local workspace folders already shared, keyed with the sharing hosts, so each is resolved once. */
    private readonly published;
    constructor(machines: WorkspaceHosts, access: WorkspaceAccess, options?: {
        home?: string;
        endpoint?: typeof sshEndpoint;
    });
    /** Workspaces other DSH instances added on shared hosts, not yet offered here. Their anchors are created. */
    shared(signal?: AbortSignal): Promise<OfferedWorkspace[]>;
    /** Share the remote workspaces this DSH already has, such as ones added before sharing existed. */
    publish(paths: string[], signal?: AbortSignal): Promise<void>;
    /** Canonicalize the directory on the verified host, then create or reuse its anchor. */
    create(hostId: string, path: string, signal?: AbortSignal): Promise<RemoteWorkspace>;
}
