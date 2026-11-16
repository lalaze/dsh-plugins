import type { LocaleContext } from '@dsh-plugins/i18n';
import React from 'react';
import { installLocale, ui } from './i18n.js';
import { machineName, notifyNotice } from './notify.js';
import { installPeerFileIntake } from './peer-files.js';
import { RestartOverlay, watchRestart } from './restart.js';
import { SettingsSection } from './settings.js';
import { CSS } from './styles.js';
import { followAttention, loadMachines, markSeen, onScreen } from './store.js';
import { MachineSwitcher } from './switcher.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void, label?: string): void;
  slots: {
    inject(name: string, factory: () => unknown): unknown;
    register(spec: Record<string, unknown>, component: React.FC<any>): unknown;
  };
}

/** A short note at the bottom of the page. */
function showNote(text: string): void {
  const note = document.createElement('div');
  note.className = 'dl-banner';
  note.setAttribute('role', 'status');
  note.textContent = text;
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 5_000);
}

export const name = 'dsh-link-client';
// The desktop language bridge initializes asynchronously; wait for it before registering UI.
export const inject = ['slots', 'locale'];

export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'dsh-link';
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.effect(() => {
    void loadMachines();
    const timer = setInterval(() => void loadMachines(), 30_000);
    return () => clearInterval(timer);
  }, 'dsh-link: machine list');
  ctx.effect(() => {
    const here = onScreen();
    const seen = () => { if (document.visibilityState === 'visible') markSeen(here); };
    // The machine on screen: what finished there is no longer news, now and whenever the page comes back.
    const stop = followAttention(notice => {
      if (notice.machine === here && (notice.frame.kind === 'done' || notice.frame.kind === 'failed') && document.visibilityState === 'visible') setTimeout(seen, 500);
      notifyNotice(notice);
    });
    const first = setTimeout(seen, 2_000);
    document.addEventListener('visibilitychange', seen);
    return () => { stop(); clearTimeout(first); document.removeEventListener('visibilitychange', seen); };
  }, 'dsh-link: attention');
  ctx.effect(watchRestart, 'dsh-link: restart watch');
  // In the desktop window, files given to another machine's page upload to it instead of naming a path on this one.
  ctx.effect(() => installPeerFileIntake(() => showNote(ui('Folders cannot be sent to {name}; drop the files themselves.', { name: machineName(onScreen()) }))), 'dsh-link: files to the machine on screen');

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-link', order: 10, locale: 'dsh-link' }, MachineSwitcher));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-link', order: 76, label: () => ui('DSH Link') }, SettingsSection));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-link-restart' }, RestartOverlay));
}
