import type { LocaleContext } from '@dsh-plugins/i18n';
import { ui, installLocale } from './i18n.js';
import React from 'react';
import { QuotaQuery } from './query.js';
import { QuotaStrip } from './strip.js';
import { QuotaDashboard } from './components.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: {
    inject(name: string, factory: () => void): unknown;
    register(spec: Record<string, unknown>, component: React.FC): unknown;
  };
}
export const name = 'dsh-magpie-quota-client';
export const inject = ['slots'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  const query = new QuotaQuery();
  ctx.effect(() => () => query.dispose());
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'magpie-quota', order: 20 }, () => <QuotaStrip query={query} />));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'magpie-quota', order: 75, label: () => ui("Magpie quota") }, () => <QuotaDashboard query={query} />));
}
