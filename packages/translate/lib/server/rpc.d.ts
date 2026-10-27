import type { TranslationSettings } from './settings.js';
export declare const MAX_SOURCE_LENGTH = 5000;
export declare const MAX_CONTEXT_LENGTH = 1000;
export declare const targetLanguages: readonly ["auto", "zh-CN", "en", "ja", "ko", "fr", "de", "es", "ru"];
export type TargetLanguage = (typeof targetLanguages)[number];
export type TranslationResult = {
    translation: string;
    detectedLanguage: string | null;
    target: Exclude<TargetLanguage, 'auto'>;
    note: string | null;
    model: string;
};
/** `context` is the passage around a short `text`, so a word is translated in the sense it is used. */
export type TranslationRequest = {
    text: string;
    target?: TargetLanguage;
    context?: string;
    settings: TranslationSettings;
};
export declare function parseTranslationRequest(value: unknown): TranslationRequest;
