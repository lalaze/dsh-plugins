import { parseTranslationRequest } from './rpc.js';
import { validateTranslationSettings } from './settings.js';
import { createUsageLedger, parseUsage } from './usage.js';
const targetLabels = { 'zh-CN': 'Simplified Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', ru: 'Russian' };
const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export function resolveTarget(text, requested) { if (requested !== 'auto')
    return requested; const cjk = [...text].filter(c => cjkCharacter.test(c)).length; const otherWords = text.match(/[\p{L}\p{N}]+/gu)?.map(word => [...word].filter(c => !cjkCharacter.test(c)).length).filter(Boolean).length ?? 0; return cjk > 0 && cjk >= otherWords ? 'en' : 'zh-CN'; }
export function buildTranslationPrompt(text, target) { return `Translate the following segment into ${targetLabels[target]}, without additional explanation.\n\n${text}`; }
export function parseTranslationOutput(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        throw new Error('The Translation API returned no translation');
    const candidates = [trimmed];
    for (const match of trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi))
        candidates.unshift(match[1].trim());
    const firstBrace = trimmed.indexOf('{'), lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace)
        candidates.unshift(trimmed.slice(firstBrace, lastBrace + 1));
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate);
            if (typeof value.translation !== 'string' || !value.translation.trim())
                continue;
            return { translation: value.translation.trim().slice(0, 20000), detectedLanguage: typeof value.detectedLanguage === 'string' ? value.detectedLanguage.trim().slice(0, 100) || null : null, note: typeof value.note === 'string' ? value.note.trim().slice(0, 1000) || null : null };
        }
        catch { }
    }
    const plain = trimmed.replace(/^```(?:\w+)?\s*/i, '').replace(/```$/i, '').trim();
    if (!plain)
        throw new Error('The Translation API returned no translation');
    return { translation: plain.slice(0, 20000), detectedLanguage: null, note: null };
}
function responseContent(value) { if (!value || typeof value !== 'object')
    throw new Error('The Translation API returned an invalid response'); const record = value; const first = (Array.isArray(record.choices) ? record.choices[0] : undefined); const message = first?.message; const content = message?.content ?? first?.text; if (typeof content === 'string')
    return content; if (Array.isArray(content)) {
    const text = content.map(part => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').join('');
    if (text)
        return text;
} throw new Error('The Translation API response is missing choices[0].message.content'); }
function apiError(body, status) { try {
    const value = JSON.parse(body);
    const error = value.error;
    const message = typeof error?.message === 'string' ? error.message : typeof value.message === 'string' ? value.message : '';
    if (message)
        return new Error(`Translation API request failed (${status}): ${message.slice(0, 500)}`);
}
catch { } const detail = body.trim().replace(/\s+/g, ' ').slice(0, 500); return new Error(`Translation API request failed (${status})${detail ? `: ${detail}` : ''}`); }
function nonThinkingOptions(endpoint) { const host = new URL(endpoint.apiUrl).hostname.toLowerCase(); if (/^dashscope(?:-[a-z0-9]+)?\.(?:[a-z0-9-]+\.)?aliyuncs\.com$/.test(host) || host.endsWith('.maas.aliyuncs.com'))
    return { enable_thinking: false }; const local = host === 'localhost' || host === '[::1]' || host.endsWith('.ts.net') || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host); return local || /qwen/i.test(endpoint.model) ? { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } } : {}; }
async function requestTranslation(endpoint, prompt, fetchImpl, recordUsage) { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60_000); try {
    const headers = { 'content-type': 'application/json' };
    if (endpoint.apiKey.trim())
        headers.authorization = `Bearer ${endpoint.apiKey.trim()}`;
    const response = await fetchImpl(endpoint.apiUrl, { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ model: endpoint.model, stream: false, ...nonThinkingOptions(endpoint), messages: [{ role: 'user', content: prompt }] }) });
    const body = await response.text();
    if (!response.ok)
        throw apiError(body, response.status);
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch {
        throw new Error('The Translation API returned invalid JSON');
    }
    recordUsage({ at: new Date().toISOString(), model: endpoint.model, endpoint: endpoint.kind, usage: parseUsage(payload) });
    return responseContent(payload);
}
catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
        throw new Error('The Translation API timed out. Try again later');
    throw error;
}
finally {
    clearTimeout(timeout);
} }
function describeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300); }
export async function translateSelection(input, fetchImpl = globalThis.fetch, recordUsage = () => { }) { const settings = validateTranslationSettings(input.settings); const target = resolveTarget(input.text, input.target ?? 'auto'); const prompt = buildTranslationPrompt(input.text, target); const primary = { apiUrl: settings.apiUrl, apiKey: settings.apiKey, model: settings.model, kind: 'primary' }; try {
    const content = await requestTranslation(primary, prompt, fetchImpl, recordUsage);
    return { ...parseTranslationOutput(content), target, model: primary.model };
}
catch (primaryError) {
    if (!settings.fallbackApiUrl || !settings.fallbackModel)
        throw primaryError;
    const fallback = { apiUrl: settings.fallbackApiUrl, apiKey: settings.fallbackApiKey, model: settings.fallbackModel, kind: 'fallback' };
    try {
        const content = await requestTranslation(fallback, prompt, fetchImpl, recordUsage);
        return { ...parseTranslationOutput(content), target, model: fallback.model };
    }
    catch (fallbackError) {
        throw new Error(`The Translation API failed on both primary and fallback endpoints (${describeError(primaryError)}; ${describeError(fallbackError)})`);
    }
} }
export function createTranslationHandler(ledger = createUsageLedger()) { let active = 0; const recordUsage = (entry) => { void ledger.record(entry); }; return async (input) => { if (active >= 3)
    throw new Error('Too many translations are running. Try again later'); active++; try {
    return await translateSelection(parseTranslationRequest(input), globalThis.fetch, recordUsage);
}
finally {
    active--;
} }; }
