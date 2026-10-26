import { createI18n } from '@dsh-plugins/i18n';

export const i18n = createI18n('dsh-session-models', {
  'Remote {cli}': '远程 {cli}',
});
export const { ui, installLocale } = i18n;
