/** Notices for other machines' waits and finished turns: in the page, and as system notifications. */
import type { AttentionNotice } from '../attention-board.js';
import { ui } from './i18n.js';
import { openMachine } from './navigate.js';
import { currentSessionOf } from './shell.js';
import { dismissToast, showToast } from './toasts.js';
import { machineList, onScreen, SELF, snapshot } from './store.js';

const PREF = 'dsh-link:notify';
export type NotifyPref = 'all' | 'waiting' | 'off';

export function notifyPref(): NotifyPref {
  try { const value = (globalThis as { __dshLinkStorage?: Storage }).__dshLinkStorage?.getItem(PREF) ?? localStorage.getItem(PREF); return value === 'waiting' || value === 'off' ? value : 'all'; } catch { return 'all'; }
}
export function setNotifyPref(value: NotifyPref): void {
  try { ((globalThis as { __dshLinkStorage?: Storage }).__dshLinkStorage ?? localStorage).setItem(PREF, value); } catch { /* not kept */ }
}

export const notificationsSupported = () => typeof Notification !== 'undefined';
export const notificationPermission = (): NotificationPermission | 'unsupported' => notificationsSupported() ? Notification.permission : 'unsupported';
export async function askPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

export function machineName(machine: string): string {
  if (machine === SELF) return snapshot().answer?.self.name || ui('This computer');
  return machineList().find(entry => entry.id === machine)?.name ?? machine;
}

const shown = new Map<string, Notification>();

function systemNotice(machine: string, frame: AttentionNotice['frame'], tag: string, title: string, body: string): void {
  if (notificationPermission() !== 'granted') return;
  let notification: Notification;
  try { notification = new Notification(title, { body, tag }); } catch { return; }
  notification.addEventListener('click', () => { window.focus(); notification.close(); openMachine(machine, frame.sessionId); });
  notification.addEventListener('close', () => { if (shown.get(tag) === notification) shown.delete(tag); });
  shown.set(tag, notification);
}

/**
 * Tell the user about one notice, unless it concerns what they are looking at. A machine not on screen gets a notice in
 * the page, and a system notification too while the page is not in front; the machine on screen shows its own state,
 * so it only gets a system notification for another conversation, or while the page is not in front.
 * @param onScreenNow - the machine the window shows now.
 */
export function notifyNotice({ machine, frame }: AttentionNotice, onScreenNow: string = onScreen()): void {
  const tag = `dsh-link:${machine}:${frame.sessionId}:${frame.key}`;
  if (frame.kind === 'resolved') { shown.get(tag)?.close(); shown.delete(tag); dismissToast(tag); return; }
  const waiting = frame.kind === 'approval' || frame.kind === 'question';
  const pref = notifyPref();
  if (pref === 'off' || (pref === 'waiting' && !waiting)) return;
  const name = machineName(machine);
  const title = { approval: ui('{name}: approval needed', { name }), question: ui('{name}: a question for you', { name }), done: ui('{name}: finished', { name }), failed: ui('{name}: failed', { name }) }[frame.kind as 'approval' | 'question' | 'done' | 'failed'];
  if (!title) return;
  const looking = document.visibilityState === 'visible' && document.hasFocus();
  const body = [frame.title || ui('Untitled conversation'), frame.detail].filter(Boolean).join('\n');
  if (machine === onScreenNow) {
    if (looking && frame.sessionId === currentSessionOf(machine)) return;
    // Every page of this host gets the notice; the shared tag makes the system show it once.
    systemNotice(machine, frame, tag, title, body);
    return;
  }
  showToast({
    tag, kind: frame.kind, heading: title, title: frame.title || ui('Untitled conversation'), detail: frame.detail,
    action: ui('Show'), closeLabel: ui('Close'), open: () => openMachine(machine, frame.sessionId),
  });
  if (!looking) systemNotice(machine, frame, tag, title, body);
}
