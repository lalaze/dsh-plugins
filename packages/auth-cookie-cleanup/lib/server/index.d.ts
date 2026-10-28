import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-auth-cookie-cleanup";
/**
 * Append Set-Cookie deletions for every stale `dsh-auth-*` cookie the request
 * carried. Headers set here are merged by the host bridge's `writeHead`.
 * @returns the expired cookie names.
 */
export declare function expireStaleAuthCookies(req: IncomingMessage, res: ServerResponse): string[];
/**
 * Workaround for deepseek-ai/deepseek-harness#10598: Desktop picks a random
 * port per launch and the host names its 60-day auth cookie after that port,
 * so cookies pile up until the Cookie header exceeds Node's 16 KB limit.
 * Every authenticated /api request expires all other-port auth cookies, so at
 * most one stale cookie survives between launches.
 */
export declare function apply(ctx: Context): void;
