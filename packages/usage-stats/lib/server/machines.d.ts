import type { MachinePart, UsageReport } from './domain.js';
/** dsh-link's `dshLink` service (version 1), as far as this plugin uses it. */
export interface LinkService {
    version: number;
    self(): {
        id: string;
        name: string;
    };
    machines(): readonly {
        id: string;
        name: string;
        state: string;
    }[];
    get(id: string, path: string, options?: {
        timeoutMs?: number;
        maxBytes?: number;
    }): Promise<{
        status: number;
        text: string;
    }>;
}
/**
 * Each machine's own report, asked of its DSH through DSH Link. A machine is asked for its own records only (no
 * `machines`), so reports never chain. When one cannot be reached or does not answer, its last answer to the same
 * query stands in, marked stale with its time: a sleeping laptop keeps the usage it had.
 */
export declare class MachineReports {
    private readonly timeoutMs;
    private shared;
    private kept;
    constructor(timeoutMs?: number);
    /**
     * `scope` is `all`, `self` or a machine's id. `search` is the query for a machine's own report. Throws for a machine
     * DSH Link does not know.
     */
    parts(link: LinkService | undefined, scope: string, search: string, local: () => UsageReport): Promise<MachinePart[]>;
    private ask;
}
/** The query a machine answers for its own report: this one without the machine scope and the export format. */
export declare function ownQuery(url: URL): string;
