import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import { expireCookie, staleAuthCookieNames } from './cookies.js';

export const name = 'dsh-auth-cookie-cleanup';

/**
 * Append Set-Cookie deletions for every stale `dsh-auth-*` cookie the request
 * carried. Headers set here are merged by the host bridge's `writeHead`.
 * @returns the expired cookie names.
 */
export function expireStaleAuthCookies(req: IncomingMessage, res: ServerResponse): string[] {
  const stale = staleAuthCookieNames(req.headers.cookie, req.headers.host);
  if (stale.length === 0 || res.headersSent) return [];
  const secure = (req.socket as Partial<TLSSocket>).encrypted === true;
  const existing = res.getHeader('set-cookie');
  const previous = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('set-cookie', [...previous, ...stale.map(name => expireCookie(name, secure))]);
  return stale;
}

/**
 * Workaround for deepseek-ai/deepseek-harness#10598: Desktop picks a random
 * port per launch and the host names its 60-day auth cookie after that port,
 * so cookies pile up until the Cookie header exceeds Node's 16 KB limit.
 * Every authenticated /api request expires all other-port auth cookies, so at
 * most one stale cookie survives between launches.
 */
export function apply(ctx: Context): void {
  let reported = false;
  ctx.on('connection/request', (req, res, next) => {
    try {
      const expired = expireStaleAuthCookies(req, res);
      if (expired.length > 0 && !reported) {
        reported = true;
        ctx.logger.info('expired %d stale dsh-auth cookie(s)', expired.length);
      }
    } catch (error) {
      ctx.logger.warn(error);
    }
    return next();
  });
}
