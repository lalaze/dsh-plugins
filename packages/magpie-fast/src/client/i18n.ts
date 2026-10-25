import { createI18n } from '@dsh-plugins/i18n';
import { useLocale as useI18n } from '@dsh-plugins/i18n/react';
import { zh } from './locales.js';

export const i18n = createI18n('dsh-magpie-fast', zh);
export const { ui, installLocale, activeLocale, formatLocale, localizeError } = i18n;
export const useLocale = () => useI18n(i18n);
