import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireUsageStore } from './store.js';
import { observe } from './observe.js';
import { parseQuery, report, toCsv, validRecord, type UsageRecord } from './domain.js';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Sent by dsh-remote-agents for remote CLI turns that no DSH model call covered, such as delegated agents. */
    'remote-agents/usage'(record: UsageRecord): void;
  }
}

export const name = 'dsh-usage-stats';
export const inject = ['llm', 'connection'];
const defaultStateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
export const Config = Schema.object({ stateDir: Schema.string().default(defaultStateDir()) });
export async function apply(ctx: Context, config: { stateDir?: string } = {}): Promise<void> {
  const path = join(config.stateDir ?? defaultStateDir(), 'usage.json');
  const lease = acquireUsageStore(path);
  try {
    const store = await lease.ready;
    ctx.effect(() => lease.release);
    ctx.on('llm/stream', (options, next) => (async function* () {
      const turn = acquireUsageStore(path);
      try {
        const store = await turn.ready;
        yield* observe(options, next, record => store.append(record), error => console.warn("[dsh-usage-stats] Could not record usage", error));
      } finally { turn.release(); }
    })(), { global: true, prepend: true });
    // Turns of main-chat remote models arrive through llm/stream above; this covers the rest without double counting.
    ctx.on('remote-agents/usage', record => {
      if (!validRecord(record) || !record.provider.startsWith('remote-cli-')) return;
      const { id, startedAt, provider, model, sessionId, purpose, status, durationMs, usage } = record;
      store.append({ id, startedAt, provider, model, ...(sessionId ? { sessionId } : {}), purpose, status, durationMs, ...(usage ? { usage } : {}) })
        .catch(error => console.warn("[dsh-usage-stats] Could not record remote agent usage", error));
    }, { global: true });
    // The host connection supplies authentication, origin checks and native carriers.
    ctx.connection.fetch.register({ path: '/api/usage-stats', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
      try {
        const url = new URL(request.url);
        const format = url.searchParams.get('format');
        if (format && format !== 'csv') throw new Error("Unsupported export format");
        const data = report(store.snapshot(), parseQuery(url), store.failedWrites);
        const headers = { 'Cache-Control': 'no-store' };
        if (format === 'csv') return new Response(toCsv(data), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dsh-usage.csv"' } });
        return Response.json(data, { headers });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not read usage" }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
    } });
  } catch (error) { lease.release(); throw error; }
}
