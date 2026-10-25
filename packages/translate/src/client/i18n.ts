import { createI18n } from '@dsh-plugins/i18n';
import { useLocale as useI18n } from '@dsh-plugins/i18n/react';
import { zh } from './locales.js';

export const i18n = createI18n('dsh-translate', zh);
export const { installLocale, localizeError, ui } = i18n;
export const useLocale = () => useI18n(i18n);
