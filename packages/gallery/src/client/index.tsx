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
    register(spec: Record<string, unknown>, component: React.FC<any>): unknown;
  };
}
export const name = 'dsh-gallery-client';
/** The key of the plugin's settings on its page in Plugins: the bundle's package name. */
export const BUNDLE_KEY = 'dsh-gallery';
// The desktop language bridge initializes asynchronously; wait for it before registering UI.
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  const controller = new GalleryController(new IndexedGalleryStorage());
  ctx.effect(() => {
    const detach = installBackground(controller); const stop = controller.start();
    return () => { detach(); stop(); };
  });
  // On the plugin's own page, which has the title and icon already. DSH shows a bundle's settings there only for an entry keyed by its package name.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY, locale: BUNDLE_KEY },
    (props: { view?: string }) => props.view === 'summary' ? <>{ui("Wallpapers for chat and the sidebar")}</> : <GalleryPage controller={controller} />));
}
