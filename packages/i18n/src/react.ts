import { useSyncExternalStore } from 'react';
import type { createI18n } from './index.js';

export function useLocale(i18n: ReturnType<typeof createI18n>): 'en' | 'zh' {
  return useSyncExternalStore(i18n.subscribe, i18n.activeLocale, () => 'en');
}
