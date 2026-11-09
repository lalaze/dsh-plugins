import type { SshTransport } from '../core/ssh.js';
/** Separate protocol, storage and non-expiring ownership from the CLI force-claim registry. */
export declare const NATIVE_SCRIPT: string;
export interface NativeRpc {
    call(hostId: string, request: Record<string, unknown>): Promise<any>;
}
/** Binary-bounded transport reuses the existing verified SSH workspace connection. */
export declare function nativeRpc(transport: SshTransport, request: Record<string, unknown>): Promise<any>;
