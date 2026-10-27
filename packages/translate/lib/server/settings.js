export const defaultTranslationSettings = {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: '',
    fallbackApiUrl: '',
    fallbackApiKey: '',
    fallbackModel: '',
    englishLockModels: 'claude, anthropic',
    paragraphTranslate: true,
};
export function parseTranslationSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const text = (key) => typeof input[key] === 'string' ? input[key] : defaultTranslationSettings[key];
    return {
        apiUrl: text('apiUrl').trim().slice(0, 2048), apiKey: text('apiKey').slice(0, 8192), model: text('model').trim().slice(0, 300),
        fallbackApiUrl: text('fallbackApiUrl').trim().slice(0, 2048), fallbackApiKey: text('fallbackApiKey').slice(0, 8192), fallbackModel: text('fallbackModel').trim().slice(0, 300),
        englishLockModels: text('englishLockModels').trim().slice(0, 2000),
        paragraphTranslate: typeof input.paragraphTranslate === 'boolean' ? input.paragraphTranslate : defaultTranslationSettings.paragraphTranslate,
    };
}
/**
 * Whether composer drafts for this model always translate into English. Keywords are separated by commas or
 * new lines and match the provider or model id case-insensitively, so `claude` covers remote Claude Code
 * (`remote-cli-claude`) and gateway ids such as `anthropic/claude-sonnet-4.5`.
 */
export function locksDraftsToEnglish(keywords, selection) {
    if (!selection)
        return false;
    const id = `${selection.provider}/${selection.model}`.toLowerCase();
    return keywords.split(/[,\n]/).some(keyword => { const value = keyword.trim().toLowerCase(); return value !== '' && id.includes(value); });
}
function validateUrl(value, invalid, protocol) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(invalid);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(protocol);
}
export function validateTranslationSettings(value) {
    const settings = parseTranslationSettings(value);
    if (!settings.apiUrl)
        throw new Error('Enter the Translation API URL first');
    validateUrl(settings.apiUrl, 'The Translation API URL is invalid', 'The Translation API URL must use HTTP or HTTPS');
    if (!settings.model)
        throw new Error('Enter a translation model first');
    if (settings.fallbackApiUrl || settings.fallbackModel) {
        if (!settings.fallbackApiUrl)
            throw new Error('Enter the fallback API URL first');
        if (!settings.fallbackModel)
            throw new Error('Enter the fallback model first');
        validateUrl(settings.fallbackApiUrl, 'The fallback API URL is invalid', 'The fallback API URL must use HTTP or HTTPS');
    }
    return settings;
}
