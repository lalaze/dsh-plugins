/**
 * The tailnet listener: binds this machine's Tailscale address only, admits a request only when `tailscale whois`
 * says it comes from this node's own user, then answers this plugin's routes or forwards into this machine's DSH with
 * the in-process login cookie. Other machines' mounts and the attention board talk to this.
 */
import http from 'node:http';
import { forwardHttp, forwardUpgrade, hostnameOf, locationUnder, remoteIp, requestHeaders, sendJson, sendText } from './proxy.js';
import { injectOwnsHost } from './rewrite.js';
/** No cross-site Fetch Metadata, and an `Origin`, when sent, naming the request's own authority. */
export function sameSite(headers) {
    if (headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === new URL(`http://${headers.host}`).host;
    }
    catch {
        return false;
    }
}
/** The listener's admission, in this order: Host names this node, same-site, not this node itself, same user. */
export class Admission {
    status;
    allowSelf;
    whois;
    hosts;
    cache = new Map();
    constructor(status, bindHost, allowSelf, whois) {
        this.status = status;
        this.allowSelf = allowSelf;
        this.whois = whois;
        this.hosts = new Set([bindHost, ...status.self.ips, status.self.dnsName].filter(Boolean).map(host => host.toLowerCase()));
    }
    async check(req) {
        const ip = remoteIp(req.socket.remoteAddress);
        // DNS rebinding: a browser that reached this listener under another name is not talking to this node on purpose.
        if (!this.hosts.has(hostnameOf(req.headers.host)))
            return { status: 421, reason: 'host', ip, node: '' };
        // Forwarding drops Origin and Fetch Metadata, so DSH cannot run its own fence on this hop; without this any page
        // open in a tailnet browser could drive DSH (a WebSocket handshake is not subject to CORS).
        if (!sameSite(req.headers))
            return { status: 403, reason: 'cross-site', ip, node: '' };
        if (!this.allowSelf && this.status.self.ips.includes(ip))
            return { status: 403, reason: 'self', ip, node: '' };
        const who = await this.identify(ip);
        if (!who || who.userId !== this.status.self.userId)
            return { status: 403, reason: 'user', ip, node: who?.node ?? '' };
        return { ip, node: who.node };
    }
    identify(ip) {
        const hit = this.cache.get(ip);
        // A page load fires dozens of requests at once: they share one lookup.
        if (hit && Date.now() - hit.at < 60_000)
            return hit.who;
        const who = this.whois(ip);
        this.cache.set(ip, { at: Date.now(), who });
        return who;
    }
}
/** Answers an admitted request: a plugin route, or this machine's DSH. */
export class Frontend {
    session;
    origin;
    routes;
    constructor(session, origin, routes) {
        this.session = session;
        this.origin = origin;
        this.routes = routes;
    }
    async http(req, res) {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        const route = this.routes.http[path];
        if (route) {
            await route(req, res);
            return;
        }
        let cookie;
        try {
            cookie = await this.session.get();
        }
        catch (error) {
            sendText(res, 502, error.message);
            return;
        }
        const target = new URL(req.url ?? '/', this.origin());
        forwardHttp(req, res, {
            target, headers: requestHeaders(req.headers, { host: this.session.authority, cookie }),
            location: locationUnder(new URL(this.origin()), ''),
            html: injectOwnsHost,
            onStatus: status => { if (status === 401)
                this.session.invalidate(); },
        });
    }
    async upgrade(req, socket, head) {
        let cookie;
        try {
            cookie = await this.session.get();
        }
        catch {
            socket.destroy();
            return;
        }
        forwardUpgrade(req, socket, head, {
            target: new URL(req.url ?? '/', this.origin()), headers: requestHeaders(req.headers, { host: this.session.authority, cookie }),
            onStatus: status => { if (status === 401)
                this.session.invalidate(); },
        });
    }
}
/** Bind the listener; a refusal is answered here and logged by the caller's `onRefused`. */
export function listen(host, port, admission, frontend, onRefused) {
    const server = http.createServer();
    const refuse = (verdict, url) => { onRefused(verdict, url); return verdict.status === 421 ? 'Misdirected request' : 'This DSH only admits its own tailnet user.'; };
    server.on('request', (req, res) => {
        void (async () => {
            const verdict = await admission.check(req);
            if (verdict.status) {
                sendText(res, verdict.status, refuse(verdict, req.url ?? ''));
                return;
            }
            await frontend.http(req, res);
        })().catch(error => { if (!res.headersSent)
            sendJson(res, 500, { error: error.message });
        else
            res.destroy(); });
    });
    // Upgraded sockets leave the server's connection table: closing must end them itself.
    const upgraded = new Set();
    server.on('upgrade', (req, socket, head) => {
        upgraded.add(socket);
        socket.on('close', () => upgraded.delete(socket));
        socket.on('error', () => socket.destroy());
        void (async () => {
            const verdict = await admission.check(req);
            if (verdict.status) {
                const text = refuse(verdict, req.url ?? '');
                socket.end(`HTTP/1.1 ${verdict.status} ${http.STATUS_CODES[verdict.status]}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
                return;
            }
            await frontend.upgrade(req, socket, head);
        })().catch(() => socket.destroy());
    });
    // A sleeping laptop leaves half-open connections behind: let keep-alive sockets go.
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 30_000;
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            const shown = host.includes(':') ? `[${host}]` : host;
            resolve({
                url: `http://${shown}:${port}`,
                close: () => new Promise(done => {
                    server.close(() => done());
                    server.closeAllConnections();
                    for (const socket of upgraded)
                        socket.destroy();
                }),
            });
        });
    });
}
