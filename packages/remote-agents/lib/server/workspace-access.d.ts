import type { Readable } from 'node:stream';
import { type HostConfig } from './domain.js';
export interface WorkspacePlacement {
    hostIds: string[];
    cwd?: string;
}
export interface Endpoint {
    host: string;
    username: string;
    port: number;
}
/** The public DSH subprocess contract; the provider owns remote workspace routing. */
export interface WorkspaceRuntime {
    spawn(spec: {
        argv: string[];
        cwd: string;
        stdio: {
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        };
        graceMs: number;
        signal: AbortSignal;
    }): {
        stdout?: Readable;
        stderr?: Readable;
        terminate(): void;
        done: Promise<{
            exitCode: number | null;
        }>;
    };
}
/** DSH's home directory, which holds dsh-remote's workspace folders under `remote-workspaces`. */
export declare const dshHome: () => string;
/** dsh-oh-my-claude's state directory, which holds its workspace bindings and placeholder folders. */
export declare const omcStateDir: () => string;
export declare const under: (root: string, path: string) => boolean;
export declare const sameEndpoint: (a: Endpoint, b: Endpoint) => boolean;
/** Resolve SSH aliases locally; do not start a CLI or connect merely to list models. */
export declare function sshEndpoint(connection: string, signal?: AbortSignal): Promise<Endpoint>;
/** Admission is derived from the workspace origin, never a display name or a matching path alone. */
export declare class WorkspaceAccess {
    private readonly hosts;
    private readonly options;
    private readonly home;
    private readonly omc;
    constructor(hosts: () => readonly HostConfig[], options?: {
        home?: string;
        omc?: string;
        endpoint?: typeof sshEndpoint;
        runtime?: () => WorkspaceRuntime | undefined;
    });
    private binding;
    resolve(cwd: string | undefined, signal?: AbortSignal): Promise<WorkspacePlacement>;
    private fromRuntime;
}
