import { createHash } from 'node:crypto';
import { gatewayURL, type Source } from './config.js';
import { normalizeQuotas, quotaId, record } from './normalize.js';
import type { GatewayQuota, QuotaReport } from './types.js';

export class QuotaError extends Error {
  constructor(public code: string, message: string, public status = 502, public retryAfter?: number) { super(message); }
}
export interface ResolvedSource extends Source { headers: Headers; error?: QuotaError }
interface Target { provider: string; user: string }
interface CacheEntry {
  report?: GatewayQuota;
  targets: Map<string, Target>;
  expiresAt: number;
  pending?: Promise<GatewayQuota>;
  refreshedAt: Map<string, number>;
}
interface Options {
  sources(): Promise<ResolvedSource[]>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cacheSeconds?: number;
}
const unavailable = () => new QuotaError('UNREACHABLE', "Could not connect to Magpie. Check that the gateway is running and reachable", 502);
const publicError = (error: unknown): QuotaError => error instanceof QuotaError ? error : unavailable();
const headerEntries = (headers: Headers): [string, string][] => {
  const entries: [string, string][] = []; headers.forEach((value, name) => entries.push([name, value])); return entries;
};
const stamp = (source: ResolvedSource) => createHash('sha256').update(JSON.stringify([source.profile.baseURL, headerEntries(source.headers).sort()])).digest('hex');

export class QuotaService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private closed = false;
  constructor(private readonly options: Options) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.ttl = Math.max(10, Math.min(300, options.cacheSeconds ?? 45)) * 1000;
  }
  close(): void { this.closed = true; this.cache.clear(); }
  private async sources(): Promise<ResolvedSource[]> {
    if (this.closed) throw new QuotaError('CLOSED', "Quota plugin is closed", 503);
    const sources = await this.options.sources();
    const unique = new Map<string, ResolvedSource>();
    for (const source of sources) unique.set(source.error ? source.id : stamp(source), source);
    const active = new Set([...unique.values()].filter(s => !s.error).map(stamp));
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
    return [...unique.values()];
  }
  private entry(source: ResolvedSource): CacheEntry {
    const key = stamp(source);
    let entry = this.cache.get(key);
    if (!entry) { entry = { targets: new Map(), expiresAt: 0, refreshedAt: new Map() }; this.cache.set(key, entry); }
    return entry;
  }
  private async request(source: ResolvedSource, method: 'GET' | 'POST', target?: Target): Promise<{ accounts: GatewayQuota['accounts']; targets: Map<string, Target> }> {
    let url: URL;
    try { url = gatewayURL(source.profile.baseURL, method === 'POST' ? 'refresh' : 'quotas'); }
    catch { throw new QuotaError('INVALID_ADDRESS', "Invalid Magpie gateway URL. Check the provider settings", 400); }
    if (target) { url.searchParams.set('provider', target.provider); if (target.user) url.searchParams.set('user', target.user); }
    let response: Response;
    try { response = await this.fetch(url, { method, headers: source.headers, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 35000 : 15000) }); }
    catch { throw unavailable(); }
    if (!response.ok) {
      if (response.status === 401) throw new QuotaError('UNAUTHORIZED', "Magpie rejected the gateway key. Check the provider's credentials", 401);
      if (response.status === 403) throw new QuotaError('FORBIDDEN', "The gateway key cannot view these accounts' quotas. Check sharing and quota visibility permissions in Magpie", 403);
      if (response.status === 404) throw new QuotaError('UNSUPPORTED', "Magpie quota endpoint not found. Check the URL or update Magpie", 404);
      if (response.status === 429) throw new QuotaError('THROTTLED', "Magpie is rate-limiting quota queries. Try again later", 429, 30);
      throw new QuotaError('UPSTREAM_ERROR', `Magpie quota endpoint is unavailable (${response.status})`);
    }
    const maxBytes = 2 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new QuotaError('INVALID_RESPONSE', "Magpie quota response is too large"); }
    let raw: unknown;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('Response too large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const accounts = normalizeQuotas(raw, headerEntries(source.headers).flatMap(([, v]) => [v, v.replace(/^Bearer\s+/i, '')]));
      const targets = new Map<string, Target>();
      for (const value of record(raw)!.data as unknown[]) {
        const row = record(value)!;
        const provider = row.provider as string;
        const kind = typeof row.kind === 'string' ? row.kind : 'subscription';
        const user = typeof row.user === 'string' ? row.user : '';
        const from = typeof row.from === 'string' ? row.from : '';
        targets.set(quotaId(provider, kind, user, from), { provider, user });
      }
      return { accounts, targets };
    } catch { throw new QuotaError('INVALID_RESPONSE', "Could not parse Magpie quota data. Try again later"); }
  }
  private async read(source: ResolvedSource, reload = false): Promise<GatewayQuota> {
    if (source.error) return { id: source.id, name: source.name, accounts: [], error: { code: source.error.code, message: source.error.message } };
    const entry = this.entry(source);
    if (entry.pending) return entry.pending;
    const age = this.now() - Date.parse(entry.report?.fetchedAt ?? '');
    if (entry.report && this.now() < entry.expiresAt && (!reload || age < 5000)) return { ...entry.report, id: source.id, name: source.name };
    const task = this.update(source, entry, 'GET'); entry.pending = task;
    try { return await task; } finally { if (entry.pending === task) entry.pending = undefined; }
  }
  private async update(source: ResolvedSource, entry: CacheEntry, method: 'GET' | 'POST', target?: Target): Promise<GatewayQuota> {
    try {
      const { accounts, targets } = await this.request(source, method, target);
      // Refresh/card responses omit last-served annotations from the report.
      if (method === 'POST') for (const account of accounts) {
        const previous = entry.report?.accounts.find(a => a.id === account.id);
        if (previous) { account.last ??= previous.last; account.lastServedAt ??= previous.lastServedAt; }
      }
      entry.report = { id: source.id, name: source.name, accounts, fetchedAt: new Date(this.now()).toISOString() };
      entry.targets = targets; entry.expiresAt = this.now() + this.ttl;
    } catch (error) {
      const e = publicError(error);
      // Authorization changes must never leave the old account list visible.
      const retain = !['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_ADDRESS', 'UNSUPPORTED'].includes(e.code);
      const previous = retain ? entry.report : undefined;
      entry.report = { id: source.id, name: source.name, accounts: previous?.accounts ?? [], fetchedAt: previous?.fetchedAt,
        stale: previous?.accounts.length ? true : undefined, error: { code: e.code, message: e.message } };
      if (!retain) entry.targets.clear();
      entry.expiresAt = this.now() + 10000;
    }
    return entry.report;
  }
  async report(reload = false): Promise<QuotaReport> {
    const sources = await this.sources();
    const gateways = await Promise.all(sources.map(s => this.read(s, reload)));
    return { generatedAt: new Date(this.now()).toISOString(), gateways };
  }
  async refresh(gatewayId: string, accountId: string): Promise<QuotaReport> {
    const source = (await this.sources()).find(s => s.id === gatewayId);
    if (!source) throw new QuotaError('UNKNOWN_GATEWAY', "This Magpie gateway configuration has changed. Reload to try again", 404);
    if (source.error) throw source.error;
    const snapshot = await this.read(source);
    const account = snapshot.accounts.find(a => a.id === accountId);
    if (!account) throw new QuotaError('UNKNOWN_ACCOUNT', "Account changed or is no longer visible. Reload to try again", 404);
    if (!account.refreshable) throw new QuotaError('REMOTE_ACCOUNT', "Connect to the Magpie instance that owns this account before refreshing", 409);
    const entry = this.entry(source);
    if (entry.pending) await entry.pending;
    const elapsed = this.now() - (entry.refreshedAt.get(accountId) ?? -Infinity);
    if (elapsed < 30000) throw new QuotaError('THROTTLED', "This account was just refreshed. Try again later", 429, Math.ceil((30000 - elapsed) / 1000));
    const target = entry.targets.get(accountId);
    if (!target) throw new QuotaError('UNKNOWN_ACCOUNT', "Account changed. Reload to try again", 404);
    entry.refreshedAt.set(accountId, this.now());
    const task = this.update(source, entry, 'POST', target); entry.pending = task;
    let updated: GatewayQuota;
    try { updated = await task; } finally { if (entry.pending === task) entry.pending = undefined; }
    if (updated.error) {
      const status = ({ FORBIDDEN: 403, UNAUTHORIZED: 401, UNSUPPORTED: 404, THROTTLED: 429 } as Record<string, number>)[updated.error.code] ?? 502;
      throw new QuotaError(updated.error.code, updated.error.message, status, status === 429 ? 30 : undefined);
    }
    // The cards endpoint omits nested remotes and report annotations. Read the
    // canonical list again, rather than losing those accounts after a refresh.
    entry.expiresAt = 0;
    return this.report();
  }
}
