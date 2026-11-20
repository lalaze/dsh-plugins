import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { type GuestTarget } from './address.js';
/** The first version of the plugin whose listener forwards. */
export declare const FORWARD_SINCE = "0.1.12";
export interface ForwardMachine {
    url: string;
    name: string;
    state: string;
    version?: string;
}
export interface WindowDeps {
    machine(id: string): ForwardMachine | undefined;
    /** Where the port last listened on is kept, so guest origins (and their storage) stay the same. */
    stateFile: string;
    warn(text: string): void;
}
/** `a.b.c` ≥ `x.y.z`, numerically, pre-release tags ignored. */
export declare function atLeast(version: string | undefined, wanted: string): boolean;
/** A request from another site is let through only when that site is a guest host of this listener too. */
export declare function admitted(headers: IncomingHttpHeaders, port: number): boolean;
/** The headers the machine's listener gets for a guest request. */
export declare function machineHeaders(headers: IncomingHttpHeaders, target: GuestTarget, listener: URL, port: number): OutgoingHttpHeaders;
/** `Set-Cookie` for the guest host: the cookie belongs to every port of its hostname, as on the machine. */
export declare function guestCookie(cookie: string, target: GuestTarget): string;
/** The response headers as the guest host needs them. */
export declare function guestHeaders(headers: OutgoingHttpHeaders, target: GuestTarget, port: number): OutgoingHttpHeaders;
export declare class WindowForwarder {
    private readonly deps;
    /** The port guest hosts are served on, once listening. */
    port: number | undefined;
    error: string | undefined;
    private servers;
    private readonly upgraded;
    constructor(deps: WindowDeps);
    /** Listen on loopback: the port used last time, else `preferred` and the ten after it. */
    start(preferred: number): Promise<void>;
    close(): Promise<void>;
    /** IPv4 and IPv6 loopback on one port; a computer without IPv6 gets IPv4 only. */
    private bind;
    private listen;
    /** The machine a guest request is for, or the refusal to answer with. */
    private route;
    private http;
    private upgrade;
}
