import type { LocaleContext } from '@dsh-plugins/i18n';
import { ui, installLocale } from './i18n.js';
import React from 'react';
import { GalleryPage } from './gallery.js';
import { GalleryController } from './controller.js';
import { IndexedGalleryStorage } from './storage.js';
import { installBackground } from './background.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  slots: {
    inject(name: string, factory: () => void): unknown;
    register(spec: Record<string, unknown>, component: React.FC): unknown;
  };
}
export const name = 'dsh-gallery-client';
export const inject = ['slots'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  const controller = new GalleryController(new IndexedGalleryStorage());
  ctx.effect(() => {
    const detach = installBackground(controller); const stop = controller.start();
    return () => { detach(); stop(); };
  });
  ctx.slots.inject('settings.section', () => {
    ctx.slots.register({ name: 'settings.section', id: 'gallery', order: 65, label: () => ui("Gallery") }, () => <GalleryPage controller={controller} />);
  });
}
