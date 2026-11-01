/**
 * Host-to-host HTTP. Every request is signed with the sender's device key and names its target device; every
 * buffered response is signed by the target and bound to the request's nonce. Tailscale carries the traffic
 * encrypted between the two machines; the signatures make sure that the peer at the other end is the paired device,
 * not merely some machine on the same tailnet.
 */
import { type Server } from 'node:http';
import { type Identity } from './identity.js';
export declare const HEADER: {
    readonly from: "x-dsync-from";
    readonly to: "x-dsync-to";
    readonly time: "x-dsync-time";
    readonly nonce: "x-dsync-nonce";
    readonly signature: "x-dsync-signature";
};
export declare class PeerError extends Error {
    readonly status: number;
    name: string;
    /** `status` 0 means the peer could not be reached. */
    constructor(message: string, status: number);
    get unreachable(): boolean;
}
/** A peer address as `host:port`, `[v6]:port` or a URL; returns its base URL. */
export declare function baseUrl(endpoint: string): string;
export interface SignedRequest {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    to: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}
/**
 * Send a signed request. The response must be signed by `verifyWith`: the peer's public key, or for a pairing
 * request, a function finding the key the response introduces.
 */
export declare function signedFetch(identity: Identity, endpoint: string, request: SignedRequest, verifyWith: string | ((body: unknown) => string | undefined)): Promise<{
    status: number;
    body: unknown;
    response: Response;
}>;
export interface InboundRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    /** Verified sender device ID; undefined for the unsigned pairing request. */
    from?: string;
    body: unknown;
    remoteAddress: string;
    signal: AbortSignal;
}
export type InboundResult = {
    status: number;
    json: unknown;
} | {
    status: number;
    stream: AsyncIterable<unknown>;
};
export interface PeerServerOptions {
    identity: Identity;
    /** Public key of a device allowed to send `path`, or undefined to refuse it. */
    keyFor(deviceId: string, path: string): string | undefined;
    handle(request: InboundRequest): Promise<InboundResult>;
    /** Accept connections from any address, not only Tailscale and loopback. For tests and unusual networks. */
    anyNetwork?: boolean;
    maxBodyBytes?: number;
    log?(message: string): void;
}
/** Tailscale's IPv4 (100.64.0.0/10) and IPv6 (fd7a:115c:a1e0::/48) ranges, and loopback. */
export declare function isTailnetOrLoopback(address: string): boolean;
export declare function createPeerServer(options: PeerServerOptions): Server;
/** Parse a newline-delimited JSON body as it arrives. */
export declare function ndjson(response: Response): AsyncIterable<unknown>;
