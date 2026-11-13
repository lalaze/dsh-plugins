import { type WorkspaceRequest } from './workspace.js';
export declare const REMOTE_BEGIN = "<<DSH-GAME-ASSETS:", REMOTE_END = ":DSH-GAME-ASSETS>>";
/** Paths one remote request carries. The whole command is one shell argument, which Linux limits to 128 KiB. */
export declare const REMOTE_CHUNK = 200;
export interface RemoteTarget {
    hostId: string;
    label: string;
    cwd: string;
}
/** The part of Remote Agents' `remoteAgentsMachines` service this plugin uses. */
export interface RemoteMachines {
    /** A conversation's verified machine and directory. With `expected`, a conversation that has moved is refused. */
    target(sessionId: string, signal?: AbortSignal, expected?: RemoteTarget): Promise<RemoteTarget>;
    withWorkspace<T>(hostId: string, verify: () => Promise<void>, action: (files: {
        /** Runs a shell command in `cwd` with the login environment; both output streams arrive together. @returns its exit code. */
        stream(cwd: string, command: string, env: Record<string, string>, output: (data: Buffer) => void, signal: AbortSignal): Promise<number | null>;
        /** Uploads a file under `cwd`'s `.dsh-remote-agents/attachments/`, checked against its digest. @returns its absolute path. */
        attach?(cwd: string, path: string, input: AsyncIterable<Uint8Array>, size: number, sha256: string, signal?: AbortSignal): Promise<string>;
    }) => Promise<T>): Promise<T>;
}
/** The shell command that runs `script` with `request` on the remote machine's Node.js. */
export declare function remoteCommand(script: string, request: WorkspaceRequest): string;
/** The answer inside a remote run's output, which may carry warnings of the shell or of Node.js around it. */
export declare function remoteAnswer(output: string, exitCode: number | null): unknown;
/** A file sent to the machine before the request runs, at `path` relative to the workspace. */
export interface Upload {
    path: string;
    data: Buffer;
    sha256: string;
}
/**
 * One request on the conversation's machine, in its workspace folder, which is verified again once the connection is
 * ready. An `upload` travels first, over the same connection, as no shell argument could hold a picture.
 */
export declare function runRemote(machines: RemoteMachines, sessionId: string, target: RemoteTarget, script: string, request: WorkspaceRequest, upload?: Upload): Promise<unknown>;
