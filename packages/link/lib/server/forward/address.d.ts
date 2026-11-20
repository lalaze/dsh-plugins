/**
 * Addresses of the machine a page belongs to, and the address the window's own browser reaches them by.
 *
 * The browser in a machine's page runs in the desktop window, on the window's computer, and the desktop app gives page
 * code no proxy. So an address on that machine (its `localhost`, its private network, its tailnet names) is loaded
 * from a guest host on the window's loopback, which forwards over the machine's own network (forward/listener.ts):
 *
 *   http://localhost:5173/x  on machine mabc  →  http://p5173.x-http.localhost.mabc.localhost:7389/x
 *
 * Chromium sends every `*.localhost` name to loopback without asking DNS or the system proxy and counts it as a secure
 * context. The registrable domain of every guest host of one machine is `<machine>.localhost`, so a page and its API
 * on another port are same-site, as on the machine itself. The host spells the original origin out, so both
 * directions are computed without a table.
 *
 * No Node imports: the frame script (frame/browser.ts) bundles this.
 */
/**
 * Whether a URL's hostname (as `URL.hostname` gives it, IPv6 in brackets) names the machine itself or its private
 * network: loopback, private, link-local and tailnet (100.64/10) addresses, single-label names, and `.localhost`,
 * `.local`, `.lan`, `.internal`, `.home.arpa`, `.test`, `.ts.net` names. Anything else is a public site.
 */
export declare function isTargetLocal(hostname: string): boolean;
/** The guest host (no port) for an origin of `machine`, or undefined when it cannot be spelled as one. */
export declare function guestHostname(origin: URL, machine: string): string | undefined;
export interface GuestTarget {
    machine: string;
    /** The origin on the machine, e.g. `http://localhost:5173`. */
    origin: string;
    /** Its hostname as the machine resolves it (IPv6 in brackets). */
    hostname: string;
}
/** Reads a guest host (`Host` header form, with port) served on `port`; undefined when it is not one. */
export declare function parseGuestHost(host: string, port: number): GuestTarget | undefined;
/** Reads a guest hostname (no port); undefined when it is not one. */
export declare function parseGuestHostname(hostname: string): GuestTarget | undefined;
/** The cookie domain shared by every guest host of one hostname on one machine (all its ports, both schemes). */
export declare function cookieDomain(target: GuestTarget): string | undefined;
/**
 * The address the window's browser loads for `url` of `machine`: a guest URL for an address on the machine, the URL
 * itself for a public site or a URL that already is a guest URL on `port`. Undefined for what is not HTTP(S) or cannot
 * be spelled as a guest host.
 */
export declare function toGuestUrl(url: string, machine: string, port: number): string | undefined;
/** Whether `url` is an address on the machine that the window's browser must not load directly. */
export declare function needsGuest(url: string, port: number): boolean;
/** The address shown for `url`: the original address for a guest URL on `port`, else `url` unchanged. */
export declare function toDisplayUrl(url: string, port: number): string;
/** The guest origin of an origin on `machine` (`http://localhost:3000` → `http://p3000.x-http.localhost.mabc.localhost:7389`). */
export declare function guestOrigin(origin: string, machine: string, port: number): string | undefined;
/**
 * Point absolute loopback URLs in a page's text (`http://localhost:3000`, `ws://127.0.0.1:24678`) at their guest hosts,
 * so a page that talks to another port of its machine reaches it there too. Only full URLs with a loopback host are
 * touched; `localhost:${port}` templates and other hosts are left alone.
 */
export declare function rewriteLoopbackUrls(text: string, machine: string, port: number): string;
