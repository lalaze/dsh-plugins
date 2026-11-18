import type { TokenUsage } from '@deepseek-ai/dsh-llm';
export interface UsageRecord {
    id: string;
    startedAt: string;
    provider: string;
    model: string;
    sessionId?: string;
    purpose: string;
    status: 'completed' | 'error' | 'cancelled';
    durationMs: number;
    usage?: TokenUsage;
    /** Remote turns: the machine's saved name. DSH model calls run on this computer and leave it unset. */
    host?: string;
    /** The conversation's workspace directory: remote for remote turns, local for DSH model calls. */
    workspace?: string;
}
export interface Totals {
    requests: number;
    completed: number;
    errors: number;
    cancelled: number;
    withUsage: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
}
export type Source = 'dsh' | 'remote-agents' | 'mausbot';
export type SourceFilter = Source | 'without-mausbot';
/** Remote CLI turns: dsh-remote-agents routes are `remote-cli-<cli>`; records from the retired dsh-claude-ssh source are `claude-ssh-<host>`. OpenMausBot ledger rows are `mausbot-<engine>`. */
export declare const sourceOf: (provider: string) => Source;
export declare const SOURCE_LABELS: Record<Source, string>;
/** dsh-remote-agents chat routes are `<machine>/<cli>/<model>[/<speed>]`; statistics keep the model and speed. */
export declare function remoteModel(route: string): string;
/** `tzOffset` is minutes east of UTC for day boundaries; without it days are UTC. */
export interface Query {
    from?: string;
    to?: string;
    provider?: string;
    model?: string;
    sessionId?: string;
    source?: SourceFilter;
    groupBy: GroupBy;
    tzOffset?: number;
}
export interface UsageGroup {
    key: string;
    label: string;
    totals: Totals;
    /** All-machines reports: the machine whose DSH holds this workspace. */
    machine?: string;
}
/** The dashboard's usage breakdowns: CLI or provider, workspace, model, model vendor and machine. */
export type Dimension = 'provider' | 'workspace' | 'model' | 'vendor' | 'host';
export declare const DIMENSIONS: readonly Dimension[];
/** Detail rows follow a dashboard category; `day`, `session` and `source` remain for API clients. */
export type GroupBy = Dimension | 'day' | 'session' | 'source';
export interface UsageReport {
    totals: Totals;
    groups: UsageGroup[];
    /** Every breakdown of the filtered records, largest first. */
    breakdowns: Record<Dimension, UsageGroup[]>;
    series: UsageGroup[];
    sources: UsageGroup[];
    filters: {
        providers: string[];
        models: string[];
        sessions: string[];
    };
    query: Query;
    recordedSince?: string;
    failedWrites: number;
    generatedAt: string;
    /** Reports over several machines (`machines=`): every machine DSH Link knows, and whether its usage is in the totals. */
    machines?: MachineUsage[];
}
/**
 * One machine of an all-machines report. `counted`: its usage is in the totals (`stale` when its last answer stood in
 * for one that failed); `skipped`: not selected; `offline`: DSH Link cannot reach it; `failed`: it did not answer.
 */
export interface MachineUsage {
    id: string;
    name: string;
    self?: true;
    state: 'counted' | 'skipped' | 'offline' | 'failed';
    error?: string;
    stale?: true;
    asOf?: string;
    totals?: Totals;
    /** Records left out because another machine has the same ones (copies from shared conversations). */
    copies?: number;
}
/** Remote turns are named by their CLI, while MausBot turns are prefixed `MausBot · <engine>` so bot usage stays distinct. */
export declare function providerLabel(provider: string): string;
/** Older remote main-chat records kept the chat route as their model. */
export declare const modelOf: (r: Pick<UsageRecord, "provider" | "model">) => string;
export declare function vendorOf(r: Pick<UsageRecord, 'provider' | 'model'>): string;
/** The DSH workspace a record belongs to, as the sidebar names it; `key` is stable across renames. */
export type WorkspaceNames = (r: UsageRecord) => {
    key: string;
    title: string;
} | undefined;
export declare function validUsage(value: unknown): value is TokenUsage;
export declare function validRecord(value: unknown): value is UsageRecord;
export declare function parseQuery(url: URL): Query;
/** A machine's own report (or why there is none) for {@link combine}. */
export interface MachinePart {
    id: string;
    name: string;
    self?: true;
    state: MachineUsage['state'];
    error?: string;
    stale?: true;
    asOf?: string;
    report?: UsageReport;
    shares?: RecordShare[];
    copies?: number;
}
/**
 * Takes out records another machine also has. Machines go by name, so every machine keeps the same copy: the first
 * machine by name that has a record keeps it. A machine whose records are not known (`shares` missing) keeps all.
 */
export declare function withoutCopies(parts: readonly MachinePart[], query: Query): MachinePart[];
/**
 * Several machines' reports as one, each machine's DSH counting its own calls (a turn is recorded only by the DSH that
 * ran it, so nothing is counted twice). By host, a machine's own DSH model calls ("This computer") go under its name;
 * its workspaces stay apart from another machine's same folder and carry the machine's name.
 */
export declare function combine(all: readonly MachinePart[], query: Query): UsageReport;
/**
 * One record of a conversation another machine's DSH also has, with where it counts in this machine's report, so that a
 * copy can be taken out again. While DSHes shared conversations, both recorded their turns; such copies match in
 * every field but the random id.
 */
export interface RecordShare {
    f: string;
    day: string;
    source: Source;
    session: string;
    keys: Record<Dimension, string>;
    totals: Totals;
}
/** What makes two machines' records the same turn. */
export declare const fingerprint: (r: UsageRecord) => string;
/** The query's records of the given conversations. */
export declare function shares(records: readonly UsageRecord[], query: Query, sessions: ReadonlySet<string>, workspaces?: WorkspaceNames): RecordShare[];
/** A machine's report without the given records. */
export declare function subtract(data: UsageReport, removed: readonly RecordShare[], query: Query): UsageReport;
export declare function report(records: readonly UsageRecord[], query: Query, failedWrites?: number, workspaces?: WorkspaceNames): UsageReport;
export declare function toCsv(data: UsageReport): string;
