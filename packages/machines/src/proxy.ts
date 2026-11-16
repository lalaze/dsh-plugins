/** HTTP and WebSocket forwarding: header filtering, `Location` rewriting, HTML rewriting, bodies streamed. */
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import zlib from 'node:zlib';

/** Set on every request a mount forwards; a mount refuses one that already carries it, so hops never chain. */
export const HOP_HEADER = 'x-dsh-machines-hop';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);
/**
 * What never crosses a hop: the browser's own credentials and markers (the next hop authenticates its own way and
 * runs its own fence), forwarding claims the browser could forge, and conditional headers of documents we rewrite.
 */
const DROP_REQUEST = new Set([...HOP_BY_HOP, 'host', 'origin', 'referer', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', HOP_HEADER]);

/** Connections made by this plugin. Own agents: the global ones may be sent through an env proxy. */
export const agents = { http: new http.Agent({ keepAlive: true, keepAliveMsecs: 4_000, maxSockets: 64 }), https: new https.Agent({ keepAlive: true, maxSockets: 64 }) };
const agentFor = (url: URL) => url.protocol === 'https:' ? agents.https : agents.http;
const moduleFor = (url: URL) => url.protocol === 'https:' ? https : http;

function connectionTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  return new Set((Array.isArray(value) ? value.join(',') : value ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean));
}

/** Headers to send upstream: the browser's own minus what {@link DROP_REQUEST} names, plus `extra`. */
export function requestHeaders(headers: IncomingHttpHeaders, extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROP_REQUEST.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return { ...out, ...extra };
}

/** Rewrites an upstream `Location` so a redirect stays under the hop that served it. */
export type LocationRewrite = (location: string) => string;

/**
 * A `Location` rewrite for a hop that serves `upstream` under `prefix`: absolute paths and absolute URLs to the
 * upstream origin get the prefix, anything else (relative, another site) is left alone.
 */
export function locationUnder(upstream: URL, prefix: string): LocationRewrite {
  return location => {
    if (location.startsWith('/') && !location.startsWith('//')) return prefix + location;
    try {
      const url = new URL(location);
      if (url.origin === upstream.origin) return prefix + url.pathname + url.search + url.hash;
    } catch { /* relative */ }
    return location;
  };
}

/** Response headers to pass back: no hop-by-hop headers and never a cookie of the next hop. */
export function responseHeaders(headers: IncomingHttpHeaders, location?: LocationRewrite): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || name === 'set-cookie') continue;
    out[name] = name === 'location' && location && typeof value === 'string' ? location(value) : value;
  }
  return out;
}

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
}

/** Text a navigation shows: Chromium replaces an error status without a body by its own error page. */
export function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function decoded(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '': case 'identity': return body;
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(body);
    case 'br': return zlib.brotliDecompressSync(body);
    case 'deflate': return zlib.inflateSync(body);
    default: throw new Error(`unsupported content-encoding ${encoding}`);
  }
}

/** Arms a connect deadline on a client request; cleared once the socket connects. */
function connectDeadline(out: http.ClientRequest, ms: number): void {
  out.on('socket', socket => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => out.destroy(Object.assign(new Error(`no answer within ${ms / 1000} s`), { code: 'ETIMEDOUT' })), ms);
    socket.once('connect', () => clearTimeout(timer));
    socket.once('secureConnect', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
  });
}

/** Forward one HTTP request; the response (event streams included) is copied as it arrives. */
export function forwardHttp(req: IncomingMessage, res: ServerResponse, forward: Forward): void {
  const { target } = forward;
  const rewrite = forward.html !== undefined && req.method === 'GET';
  const headers = { ...forward.headers };
  if (rewrite && /text\/html/i.test(String(req.headers.accept ?? ''))) {
    // A document we rewrite: ask for it whole and unencoded, and never take a 304 for an older rewrite.
    delete headers['if-none-match']; delete headers['if-modified-since'];
  }
  const out = moduleFor(target).request(target, { method: req.method, headers, agent: agentFor(target) });
  connectDeadline(out, forward.connectTimeoutMs ?? 6_000);
  let answered = false;
  out.on('response', up => {
    answered = true;
    const status = up.statusCode ?? 502;
    forward.onStatus?.(status);
    const type = String(up.headers['content-type'] ?? '');
    if (!(rewrite && status === 200 && /text\/html/i.test(type))) {
      res.writeHead(status, up.statusMessage, responseHeaders(up.headers, forward.location));
      up.pipe(res);
      up.on('error', () => res.destroy());
      return;
    }
    const chunks: Buffer[] = [];
    up.on('data', (chunk: Buffer) => chunks.push(chunk));
    up.on('error', () => res.destroy());
    up.on('end', () => {
      let html: string;
      try { html = forward.html!(decoded(Buffer.concat(chunks), up.headers['content-encoding'] as string | undefined).toString('utf8')); } catch (error) {
        sendText(res, 502, `Could not read the page: ${(error as Error).message}`);
        return;
      }
      const outHeaders = responseHeaders(up.headers, forward.location);
      for (const name of ['content-encoding', 'content-length', 'etag', 'last-modified']) delete outHeaders[name];
      const body = Buffer.from(html, 'utf8');
      res.writeHead(status, up.statusMessage, { ...outHeaders, 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  out.on('error', error => {
    if (!answered) forward.onUnreachable?.(error);
    if (!res.headersSent) sendText(res, 502, `Cannot reach ${target.host}: ${describe(error)}`);
    else res.destroy();
  });
  // An event stream lasts until the browser leaves; then the upstream request goes too.
  res.on('close', () => { if (!res.writableFinished) out.destroy(); });
  req.pipe(out);
}

/** A short reason for an upstream failure, no stack, no URL. */
export function describe(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case 'ECONNREFUSED': return 'nothing listens there (is DSH running with this plugin?)';
    case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': return 'no answer (asleep or offline?)';
    case 'EHOSTUNREACH': case 'ENETUNREACH': case 'EHOSTDOWN': return 'the machine is unreachable';
    case 'ECONNRESET': return 'the connection was reset';
    default: return error instanceof Error ? error.message : String(error);
  }
}

function writeHead(socket: Duplex, status: number, message: string, rawHeaders: string[]): void {
  let head = `HTTP/1.1 ${status} ${message}\r\n`;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === 'set-cookie') continue;
    head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  }
  socket.write(`${head}\r\n`);
}

/** Forward an HTTP upgrade (WebSocket): the handshake with filtered headers, then bytes both ways. */
export function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, forward: Pick<Forward, 'target' | 'headers' | 'onUnreachable' | 'onStatus' | 'connectTimeoutMs'>): void {
  const { target } = forward;
  const headers: OutgoingHttpHeaders = { ...forward.headers, connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' };
  // One connection per WebSocket, never a pooled one.
  const out = moduleFor(target).request(target, { method: 'GET', headers, agent: false });
  connectDeadline(out, forward.connectTimeoutMs ?? 6_000);
  const fail = (status: number, text: string) => {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
  };
  socket.on('error', () => out.destroy());
  out.on('upgrade', (up, upSocket, upHead) => {
    forward.onStatus?.(up.statusCode ?? 101);
    writeHead(socket, up.statusCode ?? 101, up.statusMessage ?? 'Switching Protocols', up.rawHeaders);
    if (upHead.length > 0) socket.write(upHead);
    if (head.length > 0) upSocket.write(head);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  out.on('response', up => {
    // The upstream refused the upgrade: pass its answer on and close.
    forward.onStatus?.(up.statusCode ?? 502);
    const chunks: Buffer[] = [];
    up.on('data', (chunk: Buffer) => chunks.push(chunk));
    up.on('end', () => {
      if (socket.destroyed) return;
      const body = Buffer.concat(chunks);
      const raw = up.rawHeaders.filter((_, i, all) => i % 2 === 0 ? !/^(content-length|transfer-encoding|connection)$/i.test(all[i]!) : !/^(content-length|transfer-encoding|connection)$/i.test(all[i - 1]!));
      writeHead(socket, up.statusCode ?? 502, up.statusMessage ?? '', [...raw, 'content-length', String(body.length), 'connection', 'close']);
      socket.end(body);
    });
  });
  out.on('error', error => { forward.onUnreachable?.(error); fail(502, `Cannot reach ${target.host}: ${describe(error)}`); });
  out.end();
}

export interface Answer { status: number; headers: IncomingHttpHeaders; body: Buffer }
/** One small request through the plugin's own agents, e.g. a hello probe or the loopback login. */
export function request(url: URL, options: { method?: string; headers?: OutgoingHttpHeaders; body?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = moduleFor(url).request(url, { method: options.method ?? 'GET', headers: options.body === undefined ? options.headers : { 'content-type': 'application/json', ...options.headers, 'content-length': Buffer.byteLength(options.body) }, agent: agentFor(url) });
    const timer = setTimeout(() => out.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), options.timeoutMs ?? 6_000);
    out.on('response', up => {
      const chunks: Buffer[] = []; let size = 0;
      up.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.maxBytes ?? 1024 * 1024)) { out.destroy(new Error('answer too large')); return; }
        chunks.push(chunk);
      });
      up.on('end', () => { clearTimeout(timer); resolve({ status: up.statusCode ?? 0, headers: up.headers, body: Buffer.concat(chunks) }); });
      up.on('error', error => { clearTimeout(timer); reject(error); });
    });
    out.on('error', error => { clearTimeout(timer); reject(error); });
    out.end(options.body);
  });
}

/** Reads a small JSON request body. */
export async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

/** The peer address of a socket without the IPv4-mapped prefix. */
export function remoteIp(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '');
}

/** Host name of a `Host` header, without port or IPv6 brackets. */
export function hostnameOf(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  const colon = host.lastIndexOf(':');
  return (colon > 0 && host.indexOf(':') === colon ? host.slice(0, colon) : host).toLowerCase();
}
