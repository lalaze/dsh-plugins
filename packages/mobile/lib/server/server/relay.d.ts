/**
 * This machine's side of a Paseo-compatible relay (protocol v2). The relay only routes bytes: it never sees the
 * keys, so everything a phone and this machine say is encrypted end to end on top of it (see `shared/channel.ts`).
 *
 * One control socket (`role=server`) tells this machine which phones are connected; for each one this machine opens
 * a data socket (`role=server&connectionId=…`) that the relay joins to the phone's socket. A phone connects with
 * `role=client`, and the relay picks its connection ID.
 */
import type { RelayState } from '../shared/protocol.js';
export interface RelayOptions {
    /** `host:port`; the port defaults to 443 with TLS and 80 without. */
    endpoint: string;
    tls: boolean;
    serverId: string;
    /** A phone connected; `socket` is open and joined to it. */
    accept(socket: WebSocket, connectionId: string): void;
    onState?(state: RelayState, error?: string): void;
    log?(message: string): void;
    WebSocket?: typeof WebSocket;
    fetch?: typeof fetch;
}
export declare function relayUrl(endpoint: string, tls: boolean, query: Record<string, string>): string;
export declare function parseEndpoint(endpoint: string, tls: boolean): {
    host: string;
    port: number;
};
export declare class Relay {
    private readonly options;
    state: RelayState;
    error?: string;
    since?: number;
    private stopped;
    private control?;
    private readonly data;
    private attempt;
    private retry?;
    private keepalive?;
    private lastSeen;
    private readonly Socket;
    constructor(options: RelayOptions);
    start(): void;
    stop(): void;
    /** Phones connected right now through this relay. */
    get connections(): number;
    private set;
    private url;
    private connect;
    private schedule;
    /** WebSocket errors carry no reason; ask the relay over HTTP why it refused, for a useful message. */
    private diagnose;
    private open;
}
