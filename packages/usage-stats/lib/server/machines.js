import { hostname } from 'node:os';
import { parseQuery, report } from './domain.js';
/** Pages polling at the same moment share one round of requests. */
const SHARED_MS = 3_000;
/** Last answers kept per machine and query, to stand in while a machine sleeps or does not answer. */
const KEPT = 200;
/** Conversations asked about in one request, to keep its address short. */
const SESSIONS_PER_REQUEST = 60;
const usable = (value) => {
    const totals = value?.totals;
    return !!totals && typeof totals === 'object' && Number.isFinite(totals.totalTokens) && Number.isFinite(totals.requests);
};
/**
 * Each machine's own report, asked of its DSH through DSH Link. A machine is asked for its own records only (no
 * `machines`), so reports never chain. When one cannot be reached or does not answer, its last answer to the same
 * query stands in, marked stale with its time: a sleeping laptop keeps the usage it had.
 */
export class MachineReports {
    timeoutMs;
    shared = new Map();
    kept = new Map();
    constructor(timeoutMs = 6_000) {
        this.timeoutMs = timeoutMs;
    }
    /**
     * `scope` is `all`, `self` or a machine's id. `search` is the query for a machine's own report. Throws for a machine
     * DSH Link does not know.
     */
    async parts(link, scope, search, local) {
        const self = link?.self() ?? { id: 'self', name: hostname().replace(/\.local$/, '') };
        const peers = link?.machines() ?? [];
        const isSelf = scope === 'self' || scope === self.id;
        if (scope !== 'all' && !isSelf && !peers.some(machine => machine.id === scope))
            throw new Error('Unknown machine');
        const own = scope === 'all' || isSelf ? { id: self.id, name: self.name, self: true, state: 'counted', report: local() } : { id: self.id, name: self.name, self: true, state: 'skipped' };
        const others = await Promise.all(peers.map(async (machine) => {
            const base = { id: machine.id, name: machine.name };
            if (scope !== 'all' && scope !== machine.id)
                return { ...base, state: 'skipped' };
            const key = `${machine.id}?${search}`;
            try {
                if (machine.state !== 'online')
                    throw new Error(machine.state);
                const answer = await this.askReport(link, machine.id, search);
                this.keep(key, answer);
                return { ...base, state: 'counted', report: answer };
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                const last = this.kept.get(key);
                if (last)
                    return { ...base, state: 'counted', stale: true, asOf: new Date(last.at).toISOString(), error: reason, report: last.report };
                return { ...base, state: machine.state === 'online' ? 'failed' : 'offline', error: reason };
            }
        }));
        return [own, ...others];
    }
    /**
     * Fills in `shares` for the conversations more than one counted machine has (copies kept from when DSHes shared
     * conversations), so that `combine` counts each such record once. `own` answers for this computer. A machine that
     * cannot say (an older version, or no answer and nothing kept) keeps all its records.
     */
    async addShares(parts, link, search, own) {
        const holders = new Map();
        for (const part of parts)
            for (const id of new Set(part.report?.filters?.sessions ?? []))
                holders.set(id, (holders.get(id) ?? 0) + 1);
        const shared = new Set([...holders].filter(([, count]) => count > 1).map(([id]) => id));
        if (!shared.size)
            return;
        await Promise.all(parts.map(async (part) => {
            const mine = [...new Set(part.report?.filters?.sessions ?? [])].filter(id => shared.has(id)).sort();
            if (!mine.length)
                return;
            if (part.self) {
                part.shares = own(new Set(mine));
                return;
            }
            if (!link)
                return;
            const found = [];
            for (let i = 0; i < mine.length; i += SESSIONS_PER_REQUEST) {
                const path = `/api/usage-stats?${search ? `${search}&` : ''}${new URLSearchParams({ shares: mine.slice(i, i + SESSIONS_PER_REQUEST).join(',') })}`;
                const key = `${part.id}?${path}`;
                try {
                    const answer = await this.ask(link, part.id, path, (value) => Array.isArray(value?.shares));
                    this.keep(key, answer);
                    found.push(...answer.shares);
                }
                catch {
                    const last = this.kept.get(key)?.report;
                    if (!last?.shares)
                        return;
                    found.push(...last.shares);
                }
            }
            part.shares = found;
        }));
    }
    keep(key, value) {
        this.kept.delete(key);
        this.kept.set(key, { at: Date.now(), report: value });
        if (this.kept.size > KEPT)
            this.kept.delete(this.kept.keys().next().value);
    }
    async askReport(link, id, search) {
        try {
            return await this.ask(link, id, `/api/usage-stats?${search}`, usable);
        }
        catch (error) {
            // Older peers (<= 0.1.21) do not know `mausbot` or `without-mausbot` and also never collect OpenMausBot usage.
            if (error instanceof Error && error.message === 'Unsupported request source') {
                const params = new URLSearchParams(search), source = params.get('source');
                if (source === 'mausbot')
                    return report([], parseQuery(new URL(`http://peer/?${search}`)));
                if (source === 'without-mausbot') {
                    params.delete('source');
                    return await this.ask(link, id, `/api/usage-stats?${params}`, usable);
                }
            }
            throw error;
        }
    }
    ask(link, id, path, check) {
        const key = `${id}?${path}`, now = Date.now();
        const hit = this.shared.get(key);
        if (hit && now - hit.at < SHARED_MS)
            return hit.answer;
        for (const [old, entry] of this.shared)
            if (now - entry.at >= SHARED_MS)
                this.shared.delete(old);
        const answer = (async () => {
            const response = await link.get(id, path, { timeoutMs: this.timeoutMs });
            let body;
            try {
                body = JSON.parse(response.text);
            }
            catch {
                throw new Error(response.status === 404 ? 'Usage statistics is not installed there' : `It answered ${response.status}`);
            }
            if (response.status !== 200)
                throw new Error(body?.error ? String(body.error) : `It answered ${response.status}`);
            if (!check(body))
                throw new Error('Unexpected answer');
            return body;
        })();
        this.shared.set(key, { at: now, answer });
        return answer;
    }
}
/** The query a machine answers for its own report: this one without the machine scope and the export format. */
export function ownQuery(url) {
    const params = new URLSearchParams(url.searchParams);
    params.delete('machines');
    params.delete('format');
    params.delete('shares');
    return params.toString();
}
