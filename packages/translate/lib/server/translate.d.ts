import { type TargetLanguage, type TranslationRequest, type TranslationResult } from './rpc.js';
import { type TranslationUsageRecord, type UsageLedger } from './usage.js';
type Fetch = typeof globalThis.fetch;
export declare function resolveTarget(text: string, requested: TargetLanguage): Exclude<TargetLanguage, 'auto'>;
export declare function buildTranslationPrompt(text: string, target: Exclude<TargetLanguage, 'auto'>, context?: string): string;
export declare function parseTranslationOutput(raw: string): Pick<TranslationResult, 'translation' | 'detectedLanguage' | 'note'>;
export declare function translateSelection(input: TranslationRequest, fetchImpl?: Fetch, recordUsage?: (entry: Omit<TranslationUsageRecord, 'v'>) => void): Promise<TranslationResult>;
export declare function createTranslationHandler(ledger?: UsageLedger): (input: unknown) => Promise<TranslationResult>;
export {};
