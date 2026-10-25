import { useSyncExternalStore } from 'react';
import type { QuotaReport } from '../types.js';

export interface QuotaState { report?: QuotaReport; loading: boolean; error?: string; refreshing?: string; cooldowns: Readonly<Record<string, number>> }
const validReport = (v: unknown): v is QuotaReport => !!v && typeof v === 'object' && typeof (v as QuotaReport).generatedAt === 'string' && Array.isArray((v as QuotaReport).gateways) && (v as QuotaReport).gateways.every(g => g && typeof g.id === 'string' && Array.isArray(g.accounts));
export const refreshKey = (gatewayId: string, accountId: string) => JSON.stringify([gatewayId, accountId]);

/** One shared query for every composer and the settings page. */
export class QuotaQuery {
  private state: QuotaState = { loading: true, cooldowns: {} };
  private readonly listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private generation = 0;
  private controller?: AbortController;
  private disposed = false;
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  getSnapshot = (): QuotaState => this.state;
  private set(patch: Partial<QuotaState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && !this.disposed) {
      void this.read(); this.timer = setInterval(() => { if (!document.hidden) void this.read(); }, 30000);
      document.addEventListener('visibilitychange', this.visible);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.timer); document.removeEventListener('visibilitychange', this.visible);
        this.controller?.abort(); this.generation++; this.pending = undefined;
        this.state = { ...this.state, refreshing: undefined, loading: !this.state.report };
      }
    };
  };
  private visible = () => { if (!document.hidden) void this.read(); };
  read = (reload = false): Promise<void> => {
    if (this.disposed || this.state.refreshing) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const controller = new AbortController(); this.controller = controller;
    this.set({ loading: !this.state.report });
    const task = (async () => {
      try {
        const response = await this.fetcher(`/api/magpie-quota${reload ? '?reload=1' : ''}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const body: unknown = await response.json();
        if (!response.ok || !validReport(body)) throw new Error("Could not read Magpie quota. Try again later");
        if (generation === this.generation && !controller.signal.aborted) this.set({ report: body, error: undefined });
      } catch (e) { if (generation === this.generation && !controller.signal.aborted) this.set({ error: e instanceof Error ? e.message : "Could not read quota" }); }
      finally { if (generation === this.generation && !controller.signal.aborted) this.set({ loading: false }); }
    })();
    this.pending = task;
    void task.finally(() => { if (this.pending === task) this.pending = undefined; });
    return task;
  };
  refresh = async (gatewayId: string, accountId: string): Promise<void> => {
    const key = refreshKey(gatewayId, accountId);
    if (this.disposed || this.state.refreshing || (this.state.cooldowns[key] ?? 0) > Date.now()) return;
    const generation = ++this.generation;
    this.controller?.abort(); this.pending = undefined;
    const controller = new AbortController(); this.controller = controller;
    this.set({ refreshing: key, error: undefined });
    let reread = false;
    try {
      const response = await this.fetcher('/api/magpie-quota', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId, accountId }) });
      const body = await response.json();
      if (!response.ok) {
        reread = [401, 403, 404].includes(response.status);
        const seconds = response.status === 429 ? Number(response.headers.get('retry-after') || body.retryAfter || 30) : 0;
        if (seconds > 0 && generation === this.generation) this.set({ cooldowns: { ...this.state.cooldowns, [key]: Date.now() + Math.min(300, seconds) * 1000 } });
        throw new Error(typeof body.error === 'string' ? body.error : "Refresh failed. Try again later");
      }
      if (!validReport(body)) throw new Error("Invalid quota response. Reload to try again");
      if (generation === this.generation && !controller.signal.aborted) this.set({ report: body, cooldowns: { ...this.state.cooldowns, [key]: Date.now() + 30000 } });
    } catch (e) { if (generation === this.generation && !controller.signal.aborted) this.set({ error: e instanceof Error ? e.message : "Refresh failed. Try again later" }); }
    finally {
      if (generation === this.generation && !controller.signal.aborted) {
        this.set({ refreshing: undefined, loading: false });
        if (reread) { this.set({ report: undefined }); await this.read(); }
      }
    }
  };
  dispose(): void {
    this.disposed = true; this.controller?.abort(); clearInterval(this.timer); this.generation++;
    document.removeEventListener('visibilitychange', this.visible); this.listeners.clear();
  }
}
export function useQuota(query: QuotaQuery): QuotaState { return useSyncExternalStore(query.subscribe, query.getSnapshot, query.getSnapshot); }
