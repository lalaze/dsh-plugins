import { hostname } from 'node:os';
import type { MachinePart, UsageReport } from './domain.js';

/** dsh-link's `dshLink` service (version 1), as far as this plugin uses it. */
export interface LinkService {
  version: number;
  self(): { id: string; name: string };
  machines(): readonly { id: string; name: string; state: string }[];
  get(id: string, path: string, options?: { timeoutMs?: number; maxBytes?: number }): Promise<{ status: number; text: string }>;
}

/** Pages polling at the same moment share one round of requests. */
const SHARED_MS = 3_000;
/** Last answers kept per machine and query, to stand in while a machine sleeps or does not answer. */
const KEPT = 200;

const usable = (value: unknown): value is UsageReport => {
  const totals = (value as UsageReport | undefined)?.totals;
  return !!totals && typeof totals === 'object' && Number.isFinite(totals.totalTokens) && Number.isFinite(totals.requests);
};

/**
 * Each machine's own report, asked of its DSH through DSH Link. A machine is asked for its own records only (no
 * `machines`), so reports never chain. When one cannot be reached or does not answer, its last answer to the same
 * query stands in, marked stale with its time: a sleeping laptop keeps the usage it had.
 */
export class MachineReports {
  private shared = new Map<string, { at: number; answer: Promise<UsageReport> }>();
  private kept = new Map<string, { at: number; report: UsageReport }>();
  constructor(private readonly timeoutMs = 6_000) {}

  /**
   * `scope` is `all`, `self` or a machine's id. `search` is the query for a machine's own report. Throws for a machine
   * DSH Link does not know.
   */
  async parts(link: LinkService | undefined, scope: string, search: string, local: () => UsageReport): Promise<MachinePart[]> {
    const self = link?.self() ?? { id: 'self', name: hostname().replace(/\.local$/, '') };
    const peers = link?.machines() ?? [];
    const isSelf = scope === 'self' || scope === self.id;
    if (scope !== 'all' && !isSelf && !peers.some(machine => machine.id === scope)) throw new Error('Unknown machine');
    const own: MachinePart = scope === 'all' || isSelf ? { id: self.id, name: self.name, self: true, state: 'counted', report: local() } : { id: self.id, name: self.name, self: true, state: 'skipped' };
    const others = await Promise.all(peers.map(async (machine): Promise<MachinePart> => {
      const base = { id: machine.id, name: machine.name };
      if (scope !== 'all' && scope !== machine.id) return { ...base, state: 'skipped' };
      const key = `${machine.id}?${search}`;
      try {
        if (machine.state !== 'online') throw new Error(machine.state);
        const report = await this.ask(link!, machine.id, search);
        this.kept.delete(key);
        this.kept.set(key, { at: Date.now(), report });
        if (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value!);
        return { ...base, state: 'counted', report };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const last = this.kept.get(key);
        if (last) return { ...base, state: 'counted', stale: true, asOf: new Date(last.at).toISOString(), error: reason, report: last.report };
        return { ...base, state: machine.state === 'online' ? 'failed' : 'offline', error: reason };
      }
    }));
    return [own, ...others];
  }

  private ask(link: LinkService, id: string, search: string): Promise<UsageReport> {
    const key = `${id}?${search}`, now = Date.now();
    const hit = this.shared.get(key);
    if (hit && now - hit.at < SHARED_MS) return hit.answer;
    for (const [old, entry] of this.shared) if (now - entry.at >= SHARED_MS) this.shared.delete(old);
    const answer = (async () => {
      const response = await link.get(id, `/api/usage-stats?${search}`, { timeoutMs: this.timeoutMs });
      let body: unknown;
      try { body = JSON.parse(response.text); } catch { throw new Error(response.status === 404 ? 'Usage statistics is not installed there' : `It answered ${response.status}`); }
      if (response.status !== 200) throw new Error((body as { error?: unknown })?.error ? String((body as { error: unknown }).error) : `It answered ${response.status}`);
      if (!usable(body)) throw new Error('Unexpected answer');
      return body;
    })();
    this.shared.set(key, { at: now, answer });
    return answer;
  }
}

/** The query a machine answers for its own report: this one without the machine scope and the export format. */
export function ownQuery(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete('machines'); params.delete('format');
  return params.toString();
}
