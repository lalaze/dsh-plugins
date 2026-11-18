import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireUsageStore } from './store.js';
import { observe } from './observe.js';
import { combine, parseQuery, report, shares, toCsv, validRecord } from './domain.js';
import { MachineReports, ownQuery } from './machines.js';
import { MausbotUsage } from './mausbot.js';
export const name = 'dsh-usage-stats';
export const inject = ['llm', 'connection'];
const defaultStateDir = () => join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'storages', name);
const defaultMausbotDir = () => process.env.OMB_DATA_DIR?.trim() || join(homedir(), '.openmausbot');
export const Config = Schema.object({
    stateDir: Schema.string().default(defaultStateDir()),
    mausbotDir: Schema.string().default(defaultMausbotDir()),
});
export async function apply(ctx, config = {}) {
    const path = join(config.stateDir ?? defaultStateDir(), 'usage.json');
    const mausbot = new MausbotUsage(config.mausbotDir ?? (config.stateDir ? undefined : defaultMausbotDir()));
    const lease = acquireUsageStore(path);
    try {
        const store = await lease.ready;
        ctx.effect(() => lease.release);
        // A conversation's workspace, from DSH's session service when it is available.
        const workspaceOf = (sessionId) => {
            if (!sessionId)
                return undefined;
            try {
                const cwd = ctx.get('sessions')?.get?.(sessionId)?.header?.cwd;
                return typeof cwd === 'string' && cwd ? cwd : undefined;
            }
            catch {
                return undefined;
            }
        };
        /**
         * DSH's workspaces as the sidebar lists them, read per report: a record belongs to the workspace holding its
         * conversation, or else the one at the directory it recorded. Without DSH's registry, records keep their directory.
         */
        const workspaceNames = () => {
            let list;
            try {
                list = ctx.get('workspaceRegistry')?.list?.() ?? [];
            }
            catch {
                return undefined;
            }
            if (!list.length)
                return undefined;
            const bySession = new Map(), byPath = new Map();
            for (const workspace of list) {
                for (const id of workspace.sessionIds)
                    bySession.set(id, workspace);
                byPath.set(workspace.path, workspace);
            }
            return r => {
                const workspace = (r.sessionId ? bySession.get(r.sessionId) : undefined) ?? (r.workspace ? byPath.get(r.workspace) : undefined);
                return workspace && workspace.title ? { key: workspace.id, title: workspace.title } : undefined;
            };
        };
        ctx.on('llm/stream', (options, next) => {
            // Remote CLI turns are recorded once from dsh-remote-agents' event, with their machine and remote directory.
            if (options.provider.startsWith('remote-cli-'))
                return next();
            return (async function* () {
                const turn = acquireUsageStore(path);
                try {
                    const store = await turn.ready;
                    yield* observe(options, next, record => store.append(record), error => console.warn("[dsh-usage-stats] Could not record usage", error), workspaceOf(options.sessionId));
                }
                finally {
                    turn.release();
                }
            })();
        }, { global: true, prepend: true });
        // Every finished remote CLI turn, including main-chat replies, which llm/stream above leaves to this event.
        ctx.on('remote-agents/usage', record => {
            if (!validRecord(record) || !record.provider.startsWith('remote-cli-'))
                return;
            const { id, startedAt, provider, model, sessionId, purpose, status, durationMs, usage, host, workspace } = record;
            store.append({ id, startedAt, provider, model, ...(sessionId ? { sessionId } : {}), purpose, status, durationMs, ...(usage ? { usage } : {}), ...(host ? { host } : {}), ...(workspace ? { workspace } : {}) })
                .catch(error => console.warn("[dsh-usage-stats] Could not record remote agent usage", error));
        }, { global: true });
        // DSH Link's machines, when it runs here: `machines=all` adds up every machine's own report.
        const link = () => {
            try {
                const service = ctx.get('dshLink');
                return service?.version === 1 ? service : undefined;
            }
            catch {
                return undefined;
            }
        };
        const machineReports = new MachineReports();
        // The host connection supplies authentication, origin checks and native carriers.
        ctx.connection.fetch.register({ path: '/api/usage-stats', methods: ['GET'], requestBody: 'buffered', fetch: async (request) => {
                try {
                    const url = new URL(request.url);
                    const format = url.searchParams.get('format');
                    if (format && format !== 'csv')
                        throw new Error("Unsupported export format");
                    const query = parseQuery(url), scope = url.searchParams.get('machines');
                    if (scope !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(scope))
                        throw new Error("Unknown machine");
                    const currentLink = link(), selfId = currentLink?.self().id ?? 'self';
                    const records = async () => {
                        const local = store.snapshot(), extra = await mausbot.records();
                        return extra.length ? [...local, ...extra] : local;
                    };
                    // Another machine asking which of these conversations' records this one has (see `MachineReports.addShares`).
                    const asked = url.searchParams.get('shares');
                    if (asked !== null && scope === null) {
                        const sessions = asked.split(',').filter(Boolean);
                        if (sessions.length > 200 || sessions.some(id => id.length > 200))
                            throw new Error("Filter value is too long");
                        return Response.json({ shares: shares(await records(), query, new Set(sessions), workspaceNames()) }, { headers: { 'Cache-Control': 'no-store' } });
                    }
                    const ownRecords = scope === null || scope === 'all' || scope === 'self' || scope === selfId ? await records() : [];
                    const own = () => report(ownRecords, query, store.failedWrites, workspaceNames());
                    const ownShares = (sessions) => shares(ownRecords, query, sessions, workspaceNames());
                    let data;
                    if (scope === null)
                        data = own();
                    else {
                        const parts = await machineReports.parts(currentLink, scope, ownQuery(url), own);
                        await machineReports.addShares(parts, currentLink, ownQuery(url), ownShares);
                        data = combine(parts, query);
                    }
                    const headers = { 'Cache-Control': 'no-store' };
                    if (format === 'csv')
                        return new Response(toCsv(data), { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dsh-usage.csv"' } });
                    return Response.json(data, { headers });
                }
                catch (error) {
                    return Response.json({ error: error instanceof Error ? error.message : "Could not read usage" }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
                }
            } });
    }
    catch (error) {
        lease.release();
        throw error;
    }
}
