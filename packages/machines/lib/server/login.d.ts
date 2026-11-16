/** A login cookie for this machine's own DSH, made in-process from its launch token; it never reaches a browser. */
import type { HostConnection } from './dsh.js';
export declare class LoopbackSession {
    private readonly connection;
    private readonly origin;
    private cookie;
    private issuedAt;
    constructor(connection: HostConnection, origin: () => string);
    /** `host:port` of this machine's DSH webServer. */
    get authority(): string;
    /** @returns the `Cookie` header value. */
    get(): Promise<string>;
    /** Drop the cookie; the next request logs in again (after an upstream 401). */
    invalidate(): void;
    private login;
}
