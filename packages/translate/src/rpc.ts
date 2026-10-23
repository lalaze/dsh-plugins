import type { TranslationSettings } from './settings.js';

export const MAX_SOURCE_LENGTH = 5000;
export const targetLanguages = ['auto', 'zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'] as const;
export type TargetLanguage = (typeof targetLanguages)[number];
export type TranslationResult = {
  translation: string;
  detectedLanguage: string | null;
  target: Exclude<TargetLanguage, 'auto'>;
  note: string | null;
  model: string;
};
export type TranslationRequest = { text: string; target?: TargetLanguage; settings: TranslationSettings };

export function parseTranslationRequest(value: unknown): TranslationRequest {
  if (!value || typeof value !== 'object') throw new Error('Request must be a JSON object');
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim() || record.text.trim().length > MAX_SOURCE_LENGTH) throw new Error('Text must contain 1–5,000 characters');
  const target = record.target === undefined ? 'auto' : record.target;
  if (typeof target !== 'string' || !(targetLanguages as readonly string[]).includes(target)) throw new Error('Unsupported target language');
  return { text: record.text.trim(), target: target as TargetLanguage, settings: record.settings as TranslationSettings };
}
