import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-translate";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export { createTranslationHandler } from './translate.js';
export { parseUsage, createUsageLedger, translationUsageRoot } from './usage.js';
export { validateTranslationSettings, defaultTranslationSettings } from './settings.js';
