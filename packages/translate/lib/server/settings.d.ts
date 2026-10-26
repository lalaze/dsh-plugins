export type TranslationSettings = {
    apiUrl: string;
    apiKey: string;
    model: string;
    fallbackApiUrl: string;
    fallbackApiKey: string;
    fallbackModel: string;
    englishLockModels: string;
};
export declare const defaultTranslationSettings: TranslationSettings;
export declare function parseTranslationSettings(value: unknown): TranslationSettings;
export declare function validateTranslationSettings(value: unknown): TranslationSettings;
