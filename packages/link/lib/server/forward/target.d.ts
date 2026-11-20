/**
 * The machine's half of forwarding: a request the window's computer marked with {@link FORWARD_HEADER} goes to that
 * address over this machine's own network, as if this machine's browser had sent it (window.ts is the other half).
 *
 * It arrives on the tailnet listener, admitted as the same tailnet user, so the window cannot reach anything here it
 * could not reach with this user's own login. Only addresses of this machine and its private network are forwarded
 * (address.ts `isTargetLocal`), the browser's cookies go along, the page's own `Origin` and `Referer` are restored
 * from the marks the window put them in (the listener's same-site fence reads the real ones), and a development
 * server's self-signed certificate is taken.
 */
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
/** The origin on this machine a forwarded request is for. */
export declare const FORWARD_HEADER = "x-dsh-link-forward";
/** The page's own `Origin` and `Referer`, as addresses of this machine. */
export declare const ORIGIN_HEADER = "x-dsh-link-origin";
export declare const REFERER_HEADER = "x-dsh-link-referer";
/** The origin a forwarded request names, when it is an HTTP(S) origin of this machine's own network. */
export declare function forwardOrigin(value: string | string[] | undefined): URL | undefined;
/** The headers the site gets: the browser's own, with `Host`, `Origin` and `Referer` as they were on the page. */
export declare function forwardedHeaders(headers: IncomingHttpHeaders, origin: URL): OutgoingHttpHeaders;
/** A TLS handshake answered in plain HTTP: the server on that port does not speak HTTPS. */
export declare function plainHttpAnswer(error: Error): boolean;
export declare function serveForward(req: IncomingMessage, res: ServerResponse, origin: URL): void;
export declare function serveForwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, origin: URL): void;
