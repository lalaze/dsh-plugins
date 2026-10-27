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
export type GroupBy = 'day' | 'model' | 'session' | 'source';
export type Source = 'dsh' | 'remote-agents';
/** Remote CLI turns: dsh-remote-agents routes are `remote-cli-<cli>`; records from the retired dsh-claude-ssh source are `claude-ssh-<host>`. */
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
    source?: Source;
    groupBy: GroupBy;
    tzOffset?: number;
}
export interface UsageGroup {
    key: string;
    label: string;
    totals: Totals;
}
/** The dashboard's usage breakdowns: CLI or provider, workspace, model, model vendor and machine. */
export type Dimension = 'provider' | 'workspace' | 'model' | 'vendor' | 'host';
export declare const DIMENSIONS: readonly Dimension[];
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
}
/** Remote turns are named by their CLI, which merges a CLI's turns across machines; DSH providers keep their ID. */
export declare function providerLabel(provider: string): string;
/** Older remote main-chat records kept the chat route as their model. */
export declare const modelOf: (r: Pick<UsageRecord, "provider" | "model">) => string;
export declare function vendorOf(r: Pick<UsageRecord, 'provider' | 'model'>): string;
export declare function validUsage(value: unknown): value is TokenUsage;
export declare function validRecord(value: unknown): value is UsageRecord;
export declare function parseQuery(url: URL): Query;
export declare function report(records: readonly UsageRecord[], query: Query, failedWrites?: number): UsageReport;
export declare function toCsv(data: UsageReport): string;
