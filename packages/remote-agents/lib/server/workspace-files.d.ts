import { type FileOperation } from './workspace-domain.js';
import { type SshTransport } from './ssh.js';
export declare class WorkspaceFiles {
    private readonly transport;
    constructor(transport: SshTransport);
    /** Runs one shell operation and returns its data; the program reports handled failures with their status. */
    private run;
    /** Remote DSH runs on Node.js, so only its own operations need it on the host. */
    private remoteDsh;
    operate(cwd: string, operation: FileOperation, signal?: AbortSignal): Promise<unknown>;
    download(cwd: string, path: string, revision: string, signal?: AbortSignal): Promise<Buffer>;
    upload(cwd: string, path: string, revision: string | null, size: number, input: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<unknown>;
}
