export type TranslationSettings = {
  apiUrl: string;
  apiKey: string;
  model: string;
  fallbackApiUrl: string;
  fallbackApiKey: string;
  fallbackModel: string;
  englishLockModels: string;
};

export const defaultTranslationSettings: TranslationSettings = {
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  model: '',
  fallbackApiUrl: '',
  fallbackApiKey: '',
  fallbackModel: '',
  englishLockModels: 'claude, anthropic',
};

export function parseTranslationSettings(value: unknown): TranslationSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const text = (key: keyof TranslationSettings) => typeof input[key] === 'string' ? input[key] as string : defaultTranslationSettings[key];
  return {
    apiUrl: text('apiUrl').trim().slice(0, 2048), apiKey: text('apiKey').slice(0, 8192), model: text('model').trim().slice(0, 300),
    fallbackApiUrl: text('fallbackApiUrl').trim().slice(0, 2048), fallbackApiKey: text('fallbackApiKey').slice(0, 8192), fallbackModel: text('fallbackModel').trim().slice(0, 300),
    englishLockModels: text('englishLockModels').trim().slice(0, 2000),
  };
}

function validateUrl(value: string, invalid: string, protocol: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(invalid); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(protocol);
}

export function validateTranslationSettings(value: unknown): TranslationSettings {
  const settings = parseTranslationSettings(value);
  if (!settings.apiUrl) throw new Error('Enter the Translation API URL first');
  validateUrl(settings.apiUrl, 'The Translation API URL is invalid', 'The Translation API URL must use HTTP or HTTPS');
  if (!settings.model) throw new Error('Enter a translation model first');
  if (settings.fallbackApiUrl || settings.fallbackModel) {
    if (!settings.fallbackApiUrl) throw new Error('Enter the fallback API URL first');
    if (!settings.fallbackModel) throw new Error('Enter the fallback model first');
    validateUrl(settings.fallbackApiUrl, 'The fallback API URL is invalid', 'The fallback API URL must use HTTP or HTTPS');
  }
  return settings;
}
