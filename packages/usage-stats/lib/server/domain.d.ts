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
export type Source = 'dsh' | 'claude-ssh';
export declare const sourceOf: (provider: string) => Source;
export interface Query {
    from?: string;
    to?: string;
    provider?: string;
    model?: string;
    sessionId?: string;
    source?: Source;
    groupBy: GroupBy;
}
export interface UsageGroup {
    key: string;
    label: string;
    totals: Totals;
}
export interface UsageReport {
    totals: Totals;
    groups: UsageGroup[];
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
export declare function validUsage(value: unknown): value is TokenUsage;
export declare function validRecord(value: unknown): value is UsageRecord;
export declare function parseQuery(url: URL): Query;
export declare function report(records: readonly UsageRecord[], query: Query, failedWrites?: number): UsageReport;
export declare function toCsv(data: UsageReport): string;
