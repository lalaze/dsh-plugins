import type { AccountQuota, QuotaWindow } from './types.js';
import { createHash } from 'node:crypto';

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const finite = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const date = (v: unknown): string | undefined => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined;
export function cleanText(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  for (const secret of [...secrets].filter(s => s.length > 5).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  return text.replace(/\b(?:Bearer\s+\S+|(?:sk-|mgp-)[A-Za-z0-9_-]{10,})/gi, "[redacted]").slice(0, 600);
}
export const quotaId = (provider: string, kind: string, user = '', from = ''): string => createHash('sha256').update(JSON.stringify([provider, kind, user, from])).digest('hex').slice(0, 24);

/** The quota report and refresh/cards have different window shapes. */
export function normalizeQuotas(value: unknown, secrets: readonly string[] = []): AccountQuota[] {
  const data = record(value)?.data;
  if (!Array.isArray(data) || data.length > 2000) throw new Error("Invalid quota response format");
  const text = (v: unknown) => cleanText(v, secrets);
  const accounts = new Map<string, AccountQuota>();
  for (const raw of data) {
    const row = record(raw);
    if (!row || typeof row.provider !== 'string' || !row.provider.trim() || !Array.isArray(row.windows) || row.windows.length > 200) throw new Error("Invalid account quota format");
    const provider = row.provider;
    const kind = typeof row.kind === 'string' ? row.kind : 'subscription';
    const user = typeof row.user === 'string' ? row.user : undefined;
    const from = text(row.from);
    const id = quotaId(provider, kind, user, from);
    const windows: QuotaWindow[] = row.windows.map((rawWindow, i) => {
      const w = record(rawWindow);
      if (!w || typeof w.name !== 'string') throw new Error("Invalid quota window format");
      const remaining = finite(w.remaining) ?? (finite(w.used) === undefined ? undefined : 100 - (w.used as number));
      return {
        id: JSON.stringify([w.name, w.pool ?? '', i]), name: text(w.name) || "Quota",
        remaining: remaining === undefined ? null : Math.min(100, Math.max(0, remaining)), unlimited: w.unlimited === true,
        resetsAt: date(w.resetsAt), amount: finite(w.amount), limit: finite(w.limit), unit: text(w.unit), display: text(w.display), pool: text(w.pool),
      };
    });
    accounts.set(id, {
      id, provider: text(provider) || 'magpie', name: text(row.name) || text(provider) || 'Magpie', kind, user: text(user), alias: text(row.alias), plan: text(row.plan), from, windows,
      balance: text(row.balance), readAt: date(row.readAt), asOf: date(row.asOf), readDeferred: row.readDeferred === true || undefined,
      error: text(row.error), last: row.last === true || undefined, lastServedAt: date(row.lastServedAt),
      until: date(row.until), renew: text(row.renew), refreshable: !from && !provider.includes('/'),
    });
  }
  return [...accounts.values()];
}
