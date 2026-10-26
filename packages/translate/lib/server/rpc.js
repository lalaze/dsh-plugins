export const MAX_SOURCE_LENGTH = 5000;
export const targetLanguages = ['auto', 'zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'];
export function parseTranslationRequest(value) {
    if (!value || typeof value !== 'object')
        throw new Error('Request must be a JSON object');
    const record = value;
    if (typeof record.text !== 'string' || !record.text.trim() || record.text.trim().length > MAX_SOURCE_LENGTH)
        throw new Error('Text must contain 1–5,000 characters');
    const target = record.target === undefined ? 'auto' : record.target;
    if (typeof target !== 'string' || !targetLanguages.includes(target))
        throw new Error('Unsupported target language');
    return { text: record.text.trim(), target: target, settings: record.settings };
}
