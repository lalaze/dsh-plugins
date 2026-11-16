/** System notifications for other machines' waits and finished turns. */
import type { AttentionNotice } from '../attention-board.js';
import { currentSession } from '../rewrite.js';
import { ui } from './i18n.js';
import { openMachine } from './navigate.js';
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

/** Show one notice, unless it concerns what the user is looking at right now. */
export function notifyNotice({ machine, frame }: AttentionNotice): void {
  const tag = `dsh-link:${machine}:${frame.sessionId}:${frame.key}`;
  if (frame.kind === 'resolved') { shown.get(tag)?.close(); shown.delete(tag); return; }
  const waiting = frame.kind === 'approval' || frame.kind === 'question';
  const pref = notifyPref();
  if (pref === 'off' || (pref === 'waiting' && !waiting)) return;
  if (notificationPermission() !== 'granted') return;
  const looking = document.visibilityState === 'visible' && document.hasFocus();
  if (looking && machine === onScreen() && frame.sessionId === currentSession(localStorage)) return;
  // Every page of this host gets the notice; the shared tag makes the system show it once.
  const name = machineName(machine);
  const title = { approval: ui('{name}: approval needed', { name }), question: ui('{name}: a question for you', { name }), done: ui('{name}: finished', { name }), failed: ui('{name}: failed', { name }) }[frame.kind as 'approval' | 'question' | 'done' | 'failed'];
  if (!title) return;
  const body = [frame.title || ui('Untitled conversation'), frame.detail].filter(Boolean).join('\n');
  let notification: Notification;
  try { notification = new Notification(title, { body, tag }); } catch { return; }
  notification.addEventListener('click', () => { window.focus(); notification.close(); openMachine(machine, frame.sessionId); });
  notification.addEventListener('close', () => { if (shown.get(tag) === notification) shown.delete(tag); });
  shown.set(tag, notification);
}
