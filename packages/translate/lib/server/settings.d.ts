export type TranslationSettings = {
    apiUrl: string;
    apiKey: string;
    model: string;
    fallbackApiUrl: string;
    fallbackApiKey: string;
    fallbackModel: string;
    englishLockModels: string;
    /** Show a translate button beside each paragraph of a chat message. */
    paragraphTranslate: boolean;
};
export type TextSetting = Exclude<keyof TranslationSettings, 'paragraphTranslate'>;
export declare const defaultTranslationSettings: TranslationSettings;
export declare function parseTranslationSettings(value: unknown): TranslationSettings;
/**
 * Whether composer drafts for this model always translate into English. Keywords are separated by commas or
 * new lines and match the provider or model id case-insensitively, so `claude` covers remote Claude Code
 * (`remote-cli-claude`) and gateway ids such as `anthropic/claude-sonnet-4.5`.
 */
export declare function locksDraftsToEnglish(keywords: string, selection: {
    provider: string;
    model: string;
} | null | undefined): boolean;
export declare function validateTranslationSettings(value: unknown): TranslationSettings;
