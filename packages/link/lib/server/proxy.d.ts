/** HTTP and WebSocket forwarding: header filtering, `Location` rewriting, HTML rewriting, bodies streamed. */
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex, Transform } from 'node:stream';
/** Set on every request a mount forwards; a mount refuses one that already carries it, so hops never chain. */
export declare const HOP_HEADER = "x-dsh-link-hop";
export declare const HOP_BY_HOP: Set<string>;
/**
 * Connections made by this plugin. Own agents: the global ones may be sent through an env proxy. `local` takes the
 * self-signed certificate of a development server on this machine's own network (forward/target.ts).
 */
export declare const agents: {
    http: http.Agent;
    https: https.Agent;
    local: https.Agent;
};
export declare function connectionTokens(headers: IncomingHttpHeaders): Set<string>;
/** Headers to send upstream: the browser's own minus what {@link DROP_REQUEST} names, plus `extra`. */
export declare function requestHeaders(headers: IncomingHttpHeaders, extra?: OutgoingHttpHeaders): OutgoingHttpHeaders;
/** Rewrites an upstream `Location` so a redirect stays under the hop that served it. */
export type LocationRewrite = (location: string) => string;
/**
 * A `Location` rewrite for a hop that serves `upstream` under `prefix`: absolute paths and absolute URLs to the
 * upstream origin get the prefix, anything else (relative, another site) is left alone.
 */
export declare function locationUnder(upstream: URL, prefix: string): LocationRewrite;
/** Response headers to pass back: no hop-by-hop headers, and no cookie of the next hop unless `cookies`. */
export declare function responseHeaders(headers: IncomingHttpHeaders, location?: LocationRewrite, cookies?: boolean): OutgoingHttpHeaders;
export interface Forward {
    /** Full upstream URL of this request. */
    target: URL;
    headers: OutgoingHttpHeaders;
    location?: LocationRewrite;
    /** Rewrites a `200 text/html` answer to a GET; the document is then buffered. */
    html?: (html: string) => string;
    /** The upstream could not be reached; the caller may re-probe. */
    onUnreachable?: (error: Error) => void;
    /** The upstream answered; given its status (e.g. 401 to drop a cached login). */
    onStatus?: (status: number) => void;
    /** Give up connecting after this long. */
    connectTimeoutMs?: number;
    /** Pass the upstream's `Set-Cookie` back: a forwarded site keeps its own cookies. */
    cookies?: boolean;
    /** Take a self-signed HTTPS certificate (a development server on the machine's own network). */
    insecure?: boolean;
    /** What a navigation gets when the upstream cannot be reached: a text, or a redirect elsewhere. */
    unreachable?: (error: Error) => string | {
        location: string;
    };
    /** Last say over the response headers passed back. */
    headersOut?: (headers: OutgoingHttpHeaders) => OutgoingHttpHeaders;
    /**
     * A text body to rewrite, chosen per response. It is buffered up to {@link TEXT_LIMIT} (a longer one passes as it
     * came), decoded and sent unencoded; a body the rewrite leaves alone, or that is not UTF-8, passes as it came.
     */
    text?: (status: number, headers: IncomingHttpHeaders) => ((body: string) => string) | undefined;
    /** A transform for a streamed body (an event stream), chosen per response. */
    stream?: (status: number, headers: IncomingHttpHeaders) => Transform | undefined;
}
/** Longest body {@link Forward.text} rewrites. */
export declare const TEXT_LIMIT: number;
/** Text a navigation shows: Chromium replaces an error status without a body by its own error page. */
export declare function sendText(res: ServerResponse, status: number, text: string): void;
export declare function sendJson(res: ServerResponse, status: number, value: unknown): void;
export declare function decoded(body: Buffer, encoding: string | undefined): Buffer;
/** Forward one HTTP request; the response (event streams included) is copied as it arrives. */
export declare function forwardHttp(req: IncomingMessage, res: ServerResponse, forward: Forward): void;
/** A short reason for an upstream failure, no stack, no URL. */
export declare function describe(error: unknown): string;
/** Forward an HTTP upgrade (WebSocket): the handshake with filtered headers, then bytes both ways. */
export declare function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, forward: Pick<Forward, 'target' | 'headers' | 'onUnreachable' | 'onStatus' | 'connectTimeoutMs' | 'cookies' | 'insecure' | 'unreachable'>): void;
export interface Answer {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}
/** One small request through the plugin's own agents, e.g. a hello probe or the loopback login. */
export declare function request(url: URL, options?: {
    method?: string;
    headers?: OutgoingHttpHeaders;
    body?: string;
    timeoutMs?: number;
    maxBytes?: number;
}): Promise<Answer>;
/** Reads a small JSON request body. */
export declare function readJson(req: IncomingMessage, limit?: number): Promise<unknown>;
/** The peer address of a socket without the IPv4-mapped prefix. */
export declare function remoteIp(address: string | undefined): string;
/** Host name of a `Host` header, without port or IPv6 brackets. */
export declare function hostnameOf(host: string | undefined): string;
