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
const SCHEMES = new Set(['http:', 'https:']);
/** Names of a private network or of the machine itself, besides IP literals and single-label names. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.test', '.ts.net'];
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const MACHINE = /^[a-z0-9]{1,40}$/;
const V6_LABEL = /^v6((?:-[0-9a-f]{1,4}){8})$/;
function ipv4(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part)))
        return undefined;
    const octets = parts.map(Number);
    return octets.every(octet => octet <= 255) ? octets : undefined;
}
function localIpv4([a, b]) {
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
/** The eight groups of an IPv6 literal (no brackets), or undefined. */
function ipv6Groups(literal) {
    let text = literal.toLowerCase();
    const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (tail) {
        const octets = ipv4(tail[1]);
        if (!octets)
            return undefined;
        text = `${text.slice(0, tail.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = text.split('::');
    if (halves.length > 2)
        return undefined;
    const side = (part) => part === '' ? [] : part.split(':');
    const head = side(halves[0]), rest = halves.length === 2 ? side(halves[1]) : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1)
        return undefined;
    const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
    if (all.length !== 8 || !all.every(group => /^[0-9a-f]{1,4}$/.test(group)))
        return undefined;
    return all.map(group => parseInt(group, 16));
}
function localIpv6(groups) {
    if (groups.slice(0, 7).every(group => group === 0) && groups[7] <= 1)
        return true; // :: and ::1
    if ((groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80)
        return true; // ULA, link-local
    if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff)
        return localIpv4([groups[6] >> 8, groups[6] & 255]);
    return false;
}
/**
 * Whether a URL's hostname (as `URL.hostname` gives it, IPv6 in brackets) names the machine itself or its private
 * network: loopback, private, link-local and tailnet (100.64/10) addresses, single-label names, and `.localhost`,
 * `.local`, `.lan`, `.internal`, `.home.arpa`, `.test`, `.ts.net` names. Anything else is a public site.
 */
export function isTargetLocal(hostname) {
    const name = hostname.toLowerCase().replace(/\.$/, '');
    if (name === '')
        return false;
    if (name.startsWith('[') && name.endsWith(']')) {
        const groups = ipv6Groups(name.slice(1, -1));
        return groups !== undefined && localIpv6(groups);
    }
    const v4 = ipv4(name);
    if (v4)
        return localIpv4(v4);
    if (name === 'localhost' || !name.includes('.'))
        return true;
    return LOCAL_SUFFIXES.some(suffix => name.endsWith(suffix));
}
/** The labels a hostname is spelled with inside a guest host, or undefined when it cannot be. */
function hostLabels(hostname) {
    const name = hostname.toLowerCase().replace(/\.$/, '');
    if (name.startsWith('[') && name.endsWith(']')) {
        const groups = ipv6Groups(name.slice(1, -1));
        return groups ? [`v6-${groups.map(group => group.toString(16)).join('-')}`] : undefined;
    }
    const labels = name.split('.');
    return labels.length > 0 && labels.every(label => LABEL.test(label)) ? labels : undefined;
}
function defaultPort(protocol) { return protocol === 'https:' ? '443' : '80'; }
/** The guest host (no port) for an origin of `machine`, or undefined when it cannot be spelled as one. */
export function guestHostname(origin, machine) {
    if (!SCHEMES.has(origin.protocol) || !MACHINE.test(machine))
        return undefined;
    const labels = hostLabels(origin.hostname);
    if (!labels)
        return undefined;
    const host = [`p${origin.port || defaultPort(origin.protocol)}`, `x-${origin.protocol.slice(0, -1)}`, ...labels, machine, 'localhost'].join('.');
    return host.length <= 253 ? host : undefined;
}
/** Reads a guest host (`Host` header form, with port) served on `port`; undefined when it is not one. */
export function parseGuestHost(host, port) {
    const match = /^([a-z0-9._-]+\.localhost):(\d{1,5})$/i.exec(host.trim());
    if (!match || Number(match[2]) !== port)
        return undefined;
    return parseGuestHostname(match[1]);
}
/** Reads a guest hostname (no port); undefined when it is not one. */
export function parseGuestHostname(hostname) {
    const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
    if (labels.length < 5 || labels.at(-1) !== 'localhost')
        return undefined;
    const portMatch = /^p(\d{1,5})$/.exec(labels[0]);
    const scheme = /^x-(https?)$/.exec(labels[1])?.[1];
    const machine = labels.at(-2);
    const middle = labels.slice(2, -2);
    if (!portMatch || !scheme || !MACHINE.test(machine) || middle.length === 0 || !middle.every(label => LABEL.test(label)))
        return undefined;
    const port = Number(portMatch[1]);
    if (port < 1 || port > 65535)
        return undefined;
    const v6 = middle.length === 1 ? V6_LABEL.exec(middle[0]) : null;
    const name = v6 ? `[${v6[1].slice(1).split('-').join(':')}]` : middle.join('.');
    try {
        const origin = new URL(`${scheme}://${name}:${port}`);
        return { machine, origin: origin.origin, hostname: origin.hostname };
    }
    catch {
        return undefined;
    }
}
/** The cookie domain shared by every guest host of one hostname on one machine (all its ports, both schemes). */
export function cookieDomain(target) {
    const labels = hostLabels(target.hostname);
    return labels ? [...labels, target.machine, 'localhost'].join('.') : undefined;
}
/**
 * The address the window's browser loads for `url` of `machine`: a guest URL for an address on the machine, the URL
 * itself for a public site or a URL that already is a guest URL on `port`. Undefined for what is not HTTP(S) or cannot
 * be spelled as a guest host.
 */
export function toGuestUrl(url, machine, port) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return undefined;
    }
    if (!SCHEMES.has(parsed.protocol))
        return undefined;
    if (Number(parsed.port) === port && parseGuestHostname(parsed.hostname))
        return parsed.href;
    if (!isTargetLocal(parsed.hostname))
        return parsed.href;
    const host = guestHostname(parsed, machine);
    if (!host)
        return undefined;
    return `http://${host}:${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
/** Whether `url` is an address on the machine that the window's browser must not load directly. */
export function needsGuest(url, port) {
    try {
        const parsed = new URL(url);
        if (!SCHEMES.has(parsed.protocol))
            return false;
        if (Number(parsed.port) === port && parseGuestHostname(parsed.hostname))
            return false;
        return isTargetLocal(parsed.hostname);
    }
    catch {
        return false;
    }
}
/** The address shown for `url`: the original address for a guest URL on `port`, else `url` unchanged. */
export function toDisplayUrl(url, port) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return url;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'ws:') || Number(parsed.port) !== port)
        return url;
    const target = parseGuestHostname(parsed.hostname);
    if (!target)
        return url;
    const origin = parsed.protocol === 'ws:' ? target.origin.replace(/^http/, 'ws') : target.origin;
    return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
/** The guest origin of an origin on `machine` (`http://localhost:3000` → `http://p3000.x-http.localhost.mabc.localhost:7389`). */
export function guestOrigin(origin, machine, port) {
    try {
        const host = guestHostname(new URL(origin), machine);
        return host ? `http://${host}:${port}` : undefined;
    }
    catch {
        return undefined;
    }
}
const LOOPBACK_URL = /(?<![\w+.-])(https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(?![\w.:-])/gi;
/**
 * Point absolute loopback URLs in a page's text (`http://localhost:3000`, `ws://127.0.0.1:24678`) at their guest hosts,
 * so a page that talks to another port of its machine reaches it there too. Only full URLs with a loopback host are
 * touched; `localhost:${port}` templates and other hosts are left alone.
 */
export function rewriteLoopbackUrls(text, machine, port) {
    return text.replace(LOOPBACK_URL, (whole, scheme, host, hostPort) => {
        const lower = scheme.toLowerCase();
        const http = lower === 'https' || lower === 'wss' ? 'https' : 'http';
        let origin;
        try {
            origin = new URL(`${http}://${host}${hostPort ?? ''}`);
        }
        catch {
            return whole;
        }
        const guest = guestHostname(origin, machine);
        if (!guest)
            return whole;
        return `${lower.startsWith('ws') ? 'ws' : 'http'}://${guest}:${port}`;
    });
}
