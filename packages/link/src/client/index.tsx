import type { LocaleContext } from '@dsh-plugins/i18n';
import React from 'react';
import { rawStorage, selectSession } from '../rewrite.js';
import { installLocale, ui } from './i18n.js';
import { machineName, notifyNotice } from './notify.js';
import { installPeerFileIntake } from './peer-files.js';
import { RestartOverlay, watchRestart } from './restart.js';
import { SettingsSection } from './settings.js';
import { installShell, keepPages, ownShell, parentShell } from './shell.js';
import { CSS } from './styles.js';
import { followAttention, loadMachines, machineList, markSeen, onScreen, SELF } from './store.js';
import { MachineSwitcher } from './switcher.js';
import { dismissMachine } from './toasts.js';

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

/** Wide screens open the other machines' pages in the background a little after start, so the first switch is instant too. */
const PREFETCH_AFTER_MS = 8_000;
const PREFETCH_MEDIA = '(min-width: 900px)';

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

  const here = onScreen();
  /** Open a conversation on this page, in place when DSH offers it. */
  const openHere = (sessionId: string) => {
    const workspace = (ctx.get as ((name: string) => unknown) | undefined)?.call(ctx, 'uiWorkspace') as { openSession?(id: string): void } | undefined;
    if (workspace?.openSession) { workspace.openSession(sessionId); return; }
    try { selectSession(rawStorage(), here === SELF ? '' : here, sessionId); } catch { /* opens where it was */ }
    location.reload();
  };

  // A page in one of the window's frames: the window's own page switches, notifies and marks what was seen.
  const framed = parentShell();
  if (framed) {
    ctx.effect(() => framed.register(window, { openSession: openHere }), 'dsh-link: page in the window');
  } else {
    ctx.effect(() => {
      const installed = installShell({
        home: here,
        openOwn: openHere,
        name: machineName,
        hintText: machine => ({ text: ui('{name} is still loading…', { name: machine }), action: ui('Open directly') }),
        restorable: id => machineList().some(machine => machine.id === id && machine.state === 'online'),
      });
      let stopped = false;
      void loadMachines().then(() => { if (!stopped && keepPages()) installed.restore(); });
      const timer = setTimeout(() => {
        if (!keepPages() || typeof matchMedia !== 'function' || !matchMedia(PREFETCH_MEDIA).matches) return;
        installed.shell.prefetch(machineList().filter(machine => machine.state === 'online').map(machine => machine.id));
      }, PREFETCH_AFTER_MS);
      return () => { stopped = true; clearTimeout(timer); installed.dispose(); };
    }, 'dsh-link: pages kept in the window');

    ctx.effect(() => {
      const shown = () => ownShell()?.current() ?? here;
      // The machine on screen: what finished there is no longer news, now and whenever the page comes back.
      const seen = () => { if (document.visibilityState === 'visible') { markSeen(shown()); dismissMachine(shown()); } };
      const stop = followAttention(notice => {
        if (notice.machine === shown() && (notice.frame.kind === 'done' || notice.frame.kind === 'failed') && document.visibilityState === 'visible') setTimeout(seen, 500);
        notifyNotice(notice, shown());
      });
      const off = ownShell()?.subscribe(seen);
      const first = setTimeout(seen, 2_000);
      document.addEventListener('visibilitychange', seen);
      return () => { stop(); off?.(); clearTimeout(first); document.removeEventListener('visibilitychange', seen); };
    }, 'dsh-link: attention');
  }
  if (framed) {
    // The switcher here still shows what waits on the other machines.
    ctx.effect(() => followAttention(() => {}), 'dsh-link: attention');
  }

  ctx.effect(watchRestart, 'dsh-link: restart watch');
  // In the desktop window, files given to another machine's page upload to it instead of naming a path on this one.
  ctx.effect(() => installPeerFileIntake(() => showNote(ui('Folders cannot be sent to {name}; drop the files themselves.', { name: machineName(onScreen()) }))), 'dsh-link: files to the machine on screen');

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-link', order: 10, locale: 'dsh-link' }, MachineSwitcher));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-link', order: 76, label: () => ui('DSH Link') }, SettingsSection));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-link-restart' }, RestartOverlay));
}
