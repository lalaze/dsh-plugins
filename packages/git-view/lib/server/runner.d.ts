/** Only this DSH home's anchor tree is remote; ordinary projects may be named remote-workspaces. */
export declare function isRemoteAnchor(cwd: string, home?: string): boolean;
export interface GitCommand {
    argv: string[];
    timeoutMs: number;
}
/** As Remote Agents' Git batch: commands run in order; `maxBytes` limits each command's standard output. */
export interface GitBatch {
    id: string;
    commands: GitCommand[];
    maxBytes: number;
    stopOnError?: boolean;
    optionalLocks?: boolean;
}
export interface GitRun {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    skipped: boolean;
}
/** Where Git runs for one workspace. `cancel` stops the request with that batch ID and skips its remaining commands. */
export interface GitRunner {
    run(batch: GitBatch, signal: AbortSignal): Promise<GitRun[]>;
    cancel(id: string): Promise<void>;
}
export declare class GitError extends Error {
    readonly status: number;
    readonly detail: {
        code?: string;
        auth?: 'https' | 'ssh';
    };
    constructor(message: string, status?: number, detail?: {
        code?: string;
        auth?: 'https' | 'ssh';
    });
}
/** The part of DSH's subprocess service this plugin uses. */
export interface Subprocess {
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    spawn(spec: {
        argv: readonly string[];
        cwd: string;
        graceMs: number;
        signal?: AbortSignal;
        env?: Record<string, string | undefined>;
        stdio: {
            stdin: 'ignore';
            stdout: {
                maxBytes: number;
            };
            stderr: {
                maxBytes: number;
            };
        };
    }): {
        done: Promise<{
            exitCode: number | null;
        }>;
        collected: {
            stdout?: {
                readFrom(offset: number): {
                    text: string;
                    lossy: boolean;
                };
            };
            stderr?: {
                readFrom(offset: number): {
                    text: string;
                };
            };
        };
    };
}
/** The service Remote Agents provides as `remoteAgentsWorkspaces`; every call rechecks the conversation's machine and folder. */
export interface RemoteTarget {
    hostId: string;
    label: string;
    cwd: string;
}
export interface RemoteWorkspaces {
    readonly gitWorkspaceVersion?: number;
    target(sessionId: string, signal?: AbortSignal): Promise<RemoteTarget>;
    git(sessionId: string, batch: GitBatch, signal?: AbortSignal, expected?: RemoteTarget): Promise<GitRun[]>;
    cancelGit(sessionId: string, id: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<void>;
    stat(sessionId: string, path: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<{
        path: string;
        revision: string;
        size: number;
    }>;
    download(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<Buffer>;
    upload(sessionId: string, path: string, revision: string | null, data: Uint8Array, signal?: AbortSignal, expected?: RemoteTarget): Promise<{
        path: string;
        revision: string;
        size: number;
    }>;
    /** A folder's entries; Remote Agents 0.2.64 and newer. */
    list?(sessionId: string, path: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<{
        path: string;
        entries: {
            name: string;
            kind: string;
            size: number;
            modified: string;
        }[];
    }>;
    /** Deletes the file read at `revision`; Remote Agents 0.2.64 and newer. */
    remove?(sessionId: string, path: string, revision: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<{
        path: string;
    }>;
}
/**
 * Git never waits for a password, an editor or a pager, and reports in English so its messages can be recognized; the
 * same environment as Remote Agents gives Git on an SSH host. Credential helpers and SSH keys keep working.
 */
export declare const GIT_ENV: {
    GIT_TERMINAL_PROMPT: string;
    GIT_ASKPASS: string;
    SSH_ASKPASS: string;
    GCM_INTERACTIVE: string;
    GIT_EDITOR: string;
    GIT_PAGER: string;
    PAGER: string;
    LC_ALL: string;
};
/** Finds Git once; on macOS the `/usr/bin/git` stub counts only with the Command Line Tools installed. */
export declare function gitExecutable(subprocess: Subprocess): () => Promise<string>;
/** Git on the DSH machine through DSH's subprocess service. `config` comes before every command, such as saved credentials. */
export declare class LocalRunner implements GitRunner {
    private readonly subprocess;
    private readonly git;
    private readonly cwd;
    private readonly config;
    private readonly cancels;
    constructor(subprocess: Subprocess, git: () => Promise<string>, cwd: string, config?: () => Promise<string[]>);
    run(batch: GitBatch, signal: AbortSignal): Promise<GitRun[]>;
    cancel(id: string): Promise<void>;
}
/** Git in a Remote Agents remote workspace, over the machine's SSH connection. */
export declare class RemoteRunner implements GitRunner {
    private readonly service;
    private readonly sessionId;
    private readonly target?;
    constructor(service: RemoteWorkspaces, sessionId: string, target?: RemoteTarget | undefined);
    run(batch: GitBatch, signal: AbortSignal): Promise<GitRun[]>;
    cancel(id: string): Promise<void>;
}
/** Remote Agents reports failures with an HTTP status; keep it. */
export declare function remoteCall<T>(call: () => Promise<T>): Promise<T>;
