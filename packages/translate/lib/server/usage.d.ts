export type TranslationUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number | null;
};
export type TranslationUsageRecord = {
    v: 1;
    at: string;
    model: string;
    endpoint: 'primary' | 'fallback';
    usage: TranslationUsage | null;
};
export declare function translationUsageRoot(env?: NodeJS.ProcessEnv, home?: string): string;
export declare function parseUsage(payload: unknown): TranslationUsage | null;
export type UsageLedger = {
    record(entry: Omit<TranslationUsageRecord, 'v'>): Promise<void>;
};
export declare function createUsageLedger(root?: string): UsageLedger;
