import type { TranslationSettings } from './settings.js';
export declare const MAX_SOURCE_LENGTH = 5000;
export declare const targetLanguages: readonly ["auto", "zh-CN", "en", "ja", "ko", "fr", "de", "es", "ru"];
export type TargetLanguage = (typeof targetLanguages)[number];
export type TranslationResult = {
    translation: string;
    detectedLanguage: string | null;
    target: Exclude<TargetLanguage, 'auto'>;
    note: string | null;
    model: string;
};
export type TranslationRequest = {
    text: string;
    target?: TargetLanguage;
    settings: TranslationSettings;
};
export declare function parseTranslationRequest(value: unknown): TranslationRequest;
