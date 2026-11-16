/** A login cookie for this machine's own DSH, made in-process from its launch token; it never reaches a browser. */
import type { HostConnection } from './dsh.js';
import { request } from './proxy.js';

/** DSH cookies last 30 days; logging in again well inside that keeps a long-running host from one stray 401. */
const LOGIN_TTL_MS = 12 * 60 * 60 * 1000;

export class LoopbackSession {
  private cookie: Promise<string> | undefined;
  private issuedAt = 0;

  constructor(private readonly connection: HostConnection, private readonly origin: () => string) {}

  /** `host:port` of this machine's DSH webServer. */
  get authority(): string { return new URL(this.origin()).host; }

  /** @returns the `Cookie` header value. */
  get(): Promise<string> {
    if (Date.now() - this.issuedAt > LOGIN_TTL_MS) this.cookie = undefined;
    if (this.cookie === undefined) {
      this.issuedAt = Date.now();
      this.cookie = this.login().catch((error: unknown) => { this.cookie = undefined; throw error; });
    }
    return this.cookie;
  }

  /** Drop the cookie; the next request logs in again (after an upstream 401). */
  invalidate(): void { this.cookie = undefined; }

  private async login(): Promise<string> {
    const answer = await request(new URL(this.connection.authenticatedUrl(`${this.origin()}/`)), { timeoutMs: 10_000 });
    const raw = answer.headers['set-cookie'];
    const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(line => line.split(';')[0]!.trim()).filter(Boolean);
    if (cookies.length === 0) throw new Error(`the login on this machine's DSH answered ${answer.status} without a cookie`);
    return cookies.join('; ');
  }
}
