import { installDevTools } from './install.js';
import { installLocale } from './i18n.js';
import type { LocaleContext } from '@dsh-plugins/i18n';

export const name = 'dsh-browser-devtools-client';
export function apply(ctx: LocaleContext & { effect(factory: () => () => void): void }): void {
  ctx.effect(() => installLocale(ctx));
  ctx.effect(() => installDevTools(document));
}
