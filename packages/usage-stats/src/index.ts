import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireUsageStore } from './store.js';
import { observe } from './observe.js';
import { parseQuery, report, toCsv, validRecord, type UsageRecord, type WorkspaceNames } from './domain.js';

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
    // A conversation's workspace, from DSH's session service when it is available.
    const workspaceOf = (sessionId?: string) => {
      if (!sessionId) return undefined;
      try { const cwd = (ctx.get('sessions') as { get?(id: string): { header?: { cwd?: unknown } } | undefined } | undefined)?.get?.(sessionId)?.header?.cwd; return typeof cwd === 'string' && cwd ? cwd : undefined; }
      catch { return undefined; }
    };
    /**
     * DSH's workspaces as the sidebar lists them, read per report: a record belongs to the workspace holding its
     * conversation, or else the one at the directory it recorded. Without DSH's registry, records keep their directory.
     */
    const workspaceNames = (): WorkspaceNames | undefined => {
      type Workspace = { id: string; path: string; title: string; sessionIds: readonly string[] };
      let list: Workspace[];
      try { list = (ctx.get('workspaceRegistry') as { list?(): Workspace[] } | undefined)?.list?.() ?? []; } catch { return undefined; }
      if (!list.length) return undefined;
      const bySession = new Map<string, Workspace>(), byPath = new Map<string, Workspace>();
      for (const workspace of list) { for (const id of workspace.sessionIds) bySession.set(id, workspace); byPath.set(workspace.path, workspace); }
      return r => {
        const workspace = (r.sessionId ? bySession.get(r.sessionId) : undefined) ?? (r.workspace ? byPath.get(r.workspace) : undefined);
        return workspace && workspace.title ? { key: workspace.id, title: workspace.title } : undefined;
      };
    };
    ctx.on('llm/stream', (options, next) => {
      // Remote CLI turns are recorded once from dsh-remote-agents' event, with their machine and remote directory.
      if (options.provider.startsWith('remote-cli-')) return next();
      return (async function* () {
        const turn = acquireUsageStore(path);
        try {
          const store = await turn.ready;
          yield* observe(options, next, record => store.append(record), error => console.warn("[dsh-usage-stats] Could not record usage", error), workspaceOf(options.sessionId));
        } finally { turn.release(); }
      })();
    }, { global: true, prepend: true });
    // Every finished remote CLI turn, including main-chat replies, which llm/stream above leaves to this event.
    ctx.on('remote-agents/usage', record => {
      if (!validRecord(record) || !record.provider.startsWith('remote-cli-')) return;
      const { id, startedAt, provider, model, sessionId, purpose, status, durationMs, usage, host, workspace } = record;
      store.append({ id, startedAt, provider, model, ...(sessionId ? { sessionId } : {}), purpose, status, durationMs, ...(usage ? { usage } : {}), ...(host ? { host } : {}), ...(workspace ? { workspace } : {}) })
        .catch(error => console.warn("[dsh-usage-stats] Could not record remote agent usage", error));
    }, { global: true });
    // The host connection supplies authentication, origin checks and native carriers.
    ctx.connection.fetch.register({ path: '/api/usage-stats', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
      try {
        const url = new URL(request.url);
        const format = url.searchParams.get('format');
        if (format && format !== 'csv') throw new Error("Unsupported export format");
        const data = report(store.snapshot(), parseQuery(url), store.failedWrites, workspaceNames());
        const headers = { 'Cache-Control': 'no-store' };
        if (format === 'csv') return new Response(toCsv(data), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dsh-usage.csv"' } });
        return Response.json(data, { headers });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not read usage" }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
    } });
  } catch (error) { lease.release(); throw error; }
}
