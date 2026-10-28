export class BridgeError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
export function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new BridgeError('Invalid request');
    return value;
}
export function string(value, max = 8192) {
    if (typeof value !== 'string' || value.length > max)
        throw new BridgeError('Invalid text');
    return value;
}
export function pageState(value) {
    const v = record(value);
    if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || typeof v.ready !== 'boolean'
        || typeof v.dark !== 'boolean' || !['en', 'zh'].includes(String(v.locale)))
        throw new BridgeError('Invalid page state');
    return { url: string(v.url), title: string(v.title, 1024), revision: Number(v.revision), ready: v.ready, dark: v.dark, locale: v.locale };
}
