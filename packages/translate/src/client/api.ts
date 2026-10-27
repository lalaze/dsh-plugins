import { defaultTranslationSettings, parseTranslationSettings, type TranslationSettings } from '../settings.js';
import type { TargetLanguage, TranslationResult } from '../rpc.js';

const STORAGE_KEY = 'dsh-translate.settings.v1';
const SETTINGS_EVENT = 'dsh-translate-settings';
export function loadSettings(): TranslationSettings { try { return parseTranslationSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')); } catch { return { ...defaultTranslationSettings }; } }
export function saveSettings(settings: TranslationSettings): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); window.dispatchEvent(new Event(SETTINGS_EVENT)); }
/** Saved settings changes from this page or another tab of the same profile. */
export function subscribeSettings(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) listener(); };
  window.addEventListener(SETTINGS_EVENT, listener); window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(SETTINGS_EVENT, listener); window.removeEventListener('storage', onStorage); };
}
export async function translate(text: string, target: TargetLanguage = 'auto', settings = loadSettings(), context?: string): Promise<TranslationResult> {
  const response = await fetch('/api/translate', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, target, settings, ...(context ? { context } : {}) }) });
  let body: unknown; try { body = await response.json(); } catch { throw new Error(`Translation request failed (${response.status})`); }
  if (!response.ok) throw new Error(body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string' ? (body as Record<string, string>).error : `Translation request failed (${response.status})`);
  return body as TranslationResult;
}
