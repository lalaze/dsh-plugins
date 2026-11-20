/**
 * The window's half of forwarding: a listener on this computer's loopback that the desktop window's browser loads a
 * machine's own addresses from (`http://p5173.x-http.localhost.mabc.localhost:7389/`, address.ts). Each request goes
 * to that machine's tailnet listener marked with the address it is for, and the machine fetches it over its own
 * network (target.ts).
 *
 * Only loopback listens, only guest hosts are answered (a DNS-rebinding name is not one), and a request from another
 * site is refused unless that site is a guest host too: a web page open in a browser on this computer cannot use it to
 * reach the machine. What comes back is made to work on the guest host: redirects, CORS, CSP and absolute loopback
 * URLs in pages and scripts point at guest hosts, and cookies are shared across the hostname's ports as they are on the
 * machine.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { connectionTokens, forwardHttp, forwardUpgrade, HOP_BY_HOP, HOP_HEADER, sendText } from '../proxy.js';
import { cookieDomain, guestOrigin, isTargetLocal, parseGuestHost, rewriteLoopbackUrls, toDisplayUrl, toGuestUrl, type GuestTarget } from './address.js';
import { FORWARD_HEADER, ORIGIN_HEADER, REFERER_HEADER } from './target.js';

/** The first version of the plugin whose listener forwards. */
export const FORWARD_SINCE = '0.1.12';

export interface ForwardMachine { url: string; name: string; state: string; version?: string }

export interface WindowDeps {
  machine(id: string): ForwardMachine | undefined;
  /** Where the port last listened on is kept, so guest origins (and their storage) stay the same. */
  stateFile: string;
  warn(text: string): void;
}

/** `a.b.c` ≥ `x.y.z`, numerically, pre-release tags ignored. */
export function atLeast(version: string | undefined, wanted: string): boolean {
  if (!version) return false;
  const parts = (text: string) => text.split(/[-+]/)[0]!.split('.').map(part => Number(part) || 0);
  const have = parts(version), need = parts(wanted);
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    if ((have[i] ?? 0) !== (need[i] ?? 0)) return (have[i] ?? 0) > (need[i] ?? 0);
  }
  return true;
}

/** Bodies whose absolute loopback URLs are pointed at guest hosts. */
const TEXT_TYPE = /^(text\/(html|javascript|css|ecmascript)|application\/(javascript|x-javascript|ecmascript|json|[\w.+-]+\+json))\b/i;
/** Not passed to the machine: hop headers, the browser's site markers (the guest's, not the page's) and forged claims. */
const DROP = new Set([...HOP_BY_HOP, 'host', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', HOP_HEADER, FORWARD_HEADER, ORIGIN_HEADER, REFERER_HEADER]);

const single = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

/** A request from another site is let through only when that site is a guest host of this listener too. */
export function admitted(headers: IncomingHttpHeaders, port: number): boolean {
  if (headers['sec-fetch-site'] !== 'cross-site') return true;
  for (const value of [single(headers.origin), single(headers.referer)]) {
    if (!value) continue;
    try { if (parseGuestHost(new URL(value).host, port)) return true; } catch { /* not a URL */ }
  }
  return false;
}

/** The headers the machine's listener gets for a guest request. */
export function machineHeaders(headers: IncomingHttpHeaders, target: GuestTarget, listener: URL, port: number): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  out.host = listener.host;
  out[FORWARD_HEADER] = target.origin;
  const origin = single(headers.origin);
  const referer = single(headers.referer);
  // The page's own addresses, as the machine knows them.
  if (origin) out[ORIGIN_HEADER] = origin === 'null' ? origin : toDisplayUrl(origin, port).replace(/\/$/, '');
  if (referer) out[REFERER_HEADER] = toDisplayUrl(referer, port);
  return out;
}

/** `Set-Cookie` for the guest host: the cookie belongs to every port of its hostname, as on the machine. */
export function guestCookie(cookie: string, target: GuestTarget): string {
  const domain = cookieDomain(target);
  if (!domain) return cookie;
  const parts = cookie.split(';').filter(part => !/^\s*domain\s*=/i.test(part));
  return [...parts, ` Domain=${domain}`].join(';');
}

/** The response headers as the guest host needs them. */
export function guestHeaders(headers: OutgoingHttpHeaders, target: GuestTarget, port: number): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...headers };
  const location = typeof out.location === 'string' ? out.location : undefined;
  if (location) {
    try {
      const absolute = new URL(location, target.origin);
      // A relative redirect stays relative; an absolute one to the machine moves to its guest host.
      if (/^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith('//')) out.location = toGuestUrl(absolute.href, target.machine, port) ?? location;
    } catch { /* leave it */ }
  }
  const allow = out['access-control-allow-origin'];
  if (typeof allow === 'string' && allow !== '*' && allow !== 'null') {
    try { if (isTargetLocal(new URL(allow).hostname)) out['access-control-allow-origin'] = guestOrigin(allow, target.machine, port) ?? allow; } catch { /* leave it */ }
  }
  for (const name of ['content-security-policy', 'content-security-policy-report-only', 'link']) {
    const value = out[name];
    if (typeof value === 'string') out[name] = rewriteLoopbackUrls(value, target.machine, port);
    else if (Array.isArray(value)) out[name] = value.map(item => rewriteLoopbackUrls(String(item), target.machine, port));
  }
  const cookies = out['set-cookie'];
  if (cookies !== undefined) out['set-cookie'] = (Array.isArray(cookies) ? cookies : [String(cookies)]).map(cookie => guestCookie(String(cookie), target));
  return out;
}

export class WindowForwarder {
  /** The port guest hosts are served on, once listening. */
  port: number | undefined;
  error: string | undefined;
  private servers: http.Server[] = [];
  private readonly upgraded = new Set<Duplex>();

  constructor(private readonly deps: WindowDeps) {}

  /** Listen on loopback: the port used last time, else `preferred` and the ten after it. */
  async start(preferred: number): Promise<void> {
    let remembered: number | undefined;
    try { remembered = Number((JSON.parse(readFileSync(this.deps.stateFile, 'utf8')) as { port?: unknown }).port) || undefined; } catch { /* first start */ }
    const ports = [...new Set([remembered, ...Array.from({ length: 11 }, (_, i) => preferred + i)].filter((port): port is number => !!port && port > 0 && port < 65536))];
    let last: Error | undefined;
    for (const port of ports) {
      try {
        this.servers = await this.bind(port);
        this.port = port;
        this.error = undefined;
        if (port !== remembered) { try { writeFileSync(this.deps.stateFile, JSON.stringify({ port })); } catch { /* next start picks again */ } }
        return;
      } catch (error) { last = error as Error; }
    }
    this.error = `no free port from ${preferred} (${last?.message ?? 'unknown'})`;
    this.deps.warn(`dsh-link: the browser's forwarding did not start: ${this.error}`);
  }

  async close(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    this.port = undefined;
    for (const socket of this.upgraded) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); })));
  }

  /** IPv4 and IPv6 loopback on one port; a computer without IPv6 gets IPv4 only. */
  private async bind(port: number): Promise<http.Server[]> {
    const v4 = await this.listen('127.0.0.1', port);
    try { return [v4, await this.listen('::1', port)]; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return [v4];
      await new Promise<void>(done => v4.close(() => done()));
      throw error;
    }
  }

  private listen(host: string, port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => this.http(req, res));
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.upgraded.add(socket);
      socket.on('close', () => this.upgraded.delete(socket));
      socket.on('error', () => socket.destroy());
      this.upgrade(req, socket, head);
    });
    server.keepAliveTimeout = 5_000;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(server); });
    });
  }

  /** The machine a guest request is for, or the refusal to answer with. */
  private route(req: IncomingMessage): { target: GuestTarget; machine: ForwardMachine; listener: URL } | { status: number; text: string } {
    const port = this.port;
    const target = port === undefined ? undefined : parseGuestHost(String(req.headers.host ?? ''), port);
    if (!target) return { status: 421, text: 'Misdirected request' };
    if (!admitted(req.headers, port!)) return { status: 403, text: 'Another site cannot use this address.' };
    const machine = this.deps.machine(target.machine);
    if (!machine) return { status: 404, text: 'This machine is not known here (any more). Open it again from DSH Link.' };
    if (machine.state !== 'online') return { status: 502, text: `${machine.name} is not reachable right now.` };
    if (!atLeast(machine.version, FORWARD_SINCE)) return { status: 502, text: `Update DSH Link on ${machine.name} to ${FORWARD_SINCE} or later to open its addresses here.` };
    return { target, machine, listener: new URL(machine.url) };
  }

  private http(req: IncomingMessage, res: ServerResponse): void {
    const routed = this.route(req);
    if ('status' in routed) { sendText(res, routed.status, routed.text); return; }
    const { target, machine, listener } = routed;
    const port = this.port!;
    forwardHttp(req, res, {
      target: new URL(req.url ?? '/', listener),
      headers: machineHeaders(req.headers, target, listener, port),
      cookies: true,
      connectTimeoutMs: 8_000,
      headersOut: headers => guestHeaders(headers, target, port),
      text: (status, headers) => status >= 200 && status < 300 && status !== 204 && status !== 206 && TEXT_TYPE.test(String(headers['content-type'] ?? ''))
        ? body => rewriteLoopbackUrls(body, target.machine, port) : undefined,
      unreachable: error => `Cannot reach ${machine.name}: ${error.message}`,
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const routed = this.route(req);
    if ('status' in routed) {
      socket.end(`HTTP/1.1 ${routed.status} ${http.STATUS_CODES[routed.status]}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(routed.text)}\r\nconnection: close\r\n\r\n${routed.text}`);
      return;
    }
    const { target, machine, listener } = routed;
    forwardUpgrade(req, socket, head, {
      target: new URL(req.url ?? '/', listener),
      headers: machineHeaders(req.headers, target, listener, this.port!),
      cookies: true,
      connectTimeoutMs: 8_000,
      unreachable: error => `Cannot reach ${machine.name}: ${error.message}`,
    });
  }
}
