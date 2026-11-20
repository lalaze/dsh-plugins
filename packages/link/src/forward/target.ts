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
import { connectionTokens, describe, forwardHttp, forwardUpgrade, HOP_BY_HOP, HOP_HEADER } from '../proxy.js';
import { isTargetLocal } from './address.js';

/** The origin on this machine a forwarded request is for. */
export const FORWARD_HEADER = 'x-dsh-link-forward';
/** The page's own `Origin` and `Referer`, as addresses of this machine. */
export const ORIGIN_HEADER = 'x-dsh-link-origin';
export const REFERER_HEADER = 'x-dsh-link-referer';

/** Never passed on to the site: hop headers, forwarding claims, this plugin's marks. */
const DROP = new Set([...HOP_BY_HOP, 'host', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', HOP_HEADER, FORWARD_HEADER, ORIGIN_HEADER, REFERER_HEADER]);

/** The origin a forwarded request names, when it is an HTTP(S) origin of this machine's own network. */
export function forwardOrigin(value: string | string[] | undefined): URL | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value || !isTargetLocal(url.hostname)) return undefined;
  return url;
}

const single = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;

/** The headers the site gets: the browser's own, with `Host`, `Origin` and `Referer` as they were on the page. */
export function forwardedHeaders(headers: IncomingHttpHeaders, origin: URL): OutgoingHttpHeaders {
  const listed = connectionTokens(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROP.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  out.host = origin.host;
  const pageOrigin = single(headers[ORIGIN_HEADER]);
  const referer = single(headers[REFERER_HEADER]);
  if (pageOrigin) out.origin = pageOrigin;
  if (referer) out.referer = referer;
  return out;
}

const unreachable = (origin: URL) => (error: Error) => `${origin.host} does not answer on this machine: ${(error as { code?: unknown }).code === 'ECONNREFUSED' ? 'nothing listens there' : describe(error)}`;

/** A TLS handshake answered in plain HTTP: the server on that port does not speak HTTPS. */
export function plainHttpAnswer(error: Error): boolean {
  return (error as { code?: unknown }).code === 'ERR_SSL_WRONG_VERSION_NUMBER' || /wrong version number/i.test(error.message);
}

export function serveForward(req: IncomingMessage, res: ServerResponse, origin: URL): void {
  const text = unreachable(origin);
  forwardHttp(req, res, {
    target: new URL(req.url ?? '/', origin), headers: forwardedHeaders(req.headers, origin),
    cookies: true, insecure: true, connectTimeoutMs: 10_000,
    // DSH's address bar makes `localhost:5173` an https address; a development server there speaks plain HTTP.
    unreachable: error => origin.protocol === 'https:' && (req.method === 'GET' || req.method === 'HEAD') && plainHttpAnswer(error)
      ? { location: new URL(req.url ?? '/', origin).href.replace(/^https:/, 'http:') } : text(error),
  });
}

export function serveForwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, origin: URL): void {
  forwardUpgrade(req, socket, head, {
    target: new URL(req.url ?? '/', origin), headers: forwardedHeaders(req.headers, origin),
    cookies: true, insecure: true, connectTimeoutMs: 10_000, unreachable: unreachable(origin),
  });
}
