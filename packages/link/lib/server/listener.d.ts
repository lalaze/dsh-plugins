import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex, Transform } from 'node:stream';
import type { LoopbackSession } from './login.js';
import type { TailnetStatus, Whois } from './tailscale.js';
export interface Verdict {
    status?: 401 | 403 | 421;
    reason?: string;
    ip: string;
    node: string;
}
/** No cross-site Fetch Metadata, and an `Origin`, when sent, naming the request's own authority. */
export declare function sameSite(headers: IncomingHttpHeaders): boolean;
/** The listener's admission, in this order: Host names this node, same-site, not this node itself, same user. */
export declare class Admission {
    private readonly status;
    private readonly allowSelf;
    private readonly whois;
    private readonly hosts;
    private readonly cache;
    constructor(status: TailnetStatus, bindHost: string, allowSelf: boolean, whois: (ip: string) => Promise<Whois | undefined>);
    check(req: IncomingMessage): Promise<Verdict>;
    private identify;
}
export interface FrontendRoutes {
    /** This plugin's own routes, by exact path; anything else goes into DSH. */
    http: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>;
    /** This machine's index as the other machines get it, after `ownsHost` (browser-panel.ts adds the panel). */
    page?: (html: string) => string;
    /** This machine's `/plugins/events` stream as the other machines get it. */
    events?: () => Transform | undefined;
    /** Requests a window marked for an address of this machine's network (forward/target.ts); refused without it. */
    forward?: {
        http(req: IncomingMessage, res: ServerResponse, origin: URL): void;
        upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, origin: URL): void;
    };
}
/** Answers an admitted request: a plugin route, or this machine's DSH. */
export declare class Frontend {
    private readonly session;
    private readonly origin;
    private readonly routes;
    constructor(session: LoopbackSession, origin: () => string, routes: FrontendRoutes);
    http(req: IncomingMessage, res: ServerResponse): Promise<void>;
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}
export interface Listening {
    url: string;
    close(): Promise<void>;
}
/** Bind the listener; a refusal is answered here and logged by the caller's `onRefused`. */
export declare function listen(host: string, port: number, admission: Admission, frontend: Frontend, onRefused: (verdict: Verdict, url: string) => void): Promise<Listening>;
