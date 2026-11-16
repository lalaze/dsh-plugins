/**
 * Notices in the page for what happens on the machines not on screen: a turn finished or failed, an approval or a
 * question waits. They need no browser permission, so they also show in a phone browser and in the desktop window.
 * Plain DOM in one layer over everything, the frames of other machines included.
 */
import type { AttentionFrame } from '../attention.js';

export interface Toast {
  tag: string;
  kind: AttentionFrame['kind'];
  heading: string;
  title: string;
  detail: string;
  action: string;
  closeLabel: string;
  open(): void;
}

/** How long a notice stays while the page is in view; waits stay until they end or are closed. */
const LIFETIME: Partial<Record<AttentionFrame['kind'], number>> = { done: 12_000, failed: 30_000 };
const MAX = 4;

interface Shown { element: HTMLElement; timer?: ReturnType<typeof setTimeout>; left: number; since: number; hovered: boolean }

let layer: HTMLElement | undefined;
const shown = new Map<string, Shown>();

function ensureLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.className = 'dl-toasts';
  layer.setAttribute('role', 'region');
  layer.setAttribute('aria-live', 'polite');
  document.body.appendChild(layer);
  return layer;
}

const running = () => document.visibilityState === 'visible';

function arm(tag: string, entry: Shown): void {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  if (!Number.isFinite(entry.left) || entry.hovered || !running()) return;
  entry.since = Date.now();
  entry.timer = setTimeout(() => dismissToast(tag), entry.left);
}

function pause(entry: Shown): void {
  if (entry.timer === undefined) return;
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.left = Math.max(1_500, entry.left - (Date.now() - entry.since));
}

document.addEventListener('visibilitychange', () => {
  for (const [tag, entry] of shown) { if (running()) arm(tag, entry); else pause(entry); }
});

export function showToast(toast: Toast): void {
  dismissToast(toast.tag);
  const root = ensureLayer();
  const element = document.createElement('div');
  element.className = 'dl-toast';
  element.dataset.kind = toast.kind;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dl-toast-open';
  const heading = document.createElement('span');
  heading.className = 'dl-toast-heading';
  const dot = document.createElement('span');
  dot.className = 'dl-toast-dot';
  dot.setAttribute('aria-hidden', 'true');
  heading.append(dot, document.createTextNode(toast.heading));
  const title = document.createElement('span');
  title.className = 'dl-toast-title';
  title.textContent = toast.title;
  open.append(heading, title);
  if (toast.detail) {
    const detail = document.createElement('span');
    detail.className = 'dl-toast-detail';
    detail.textContent = toast.detail;
    open.append(detail);
  }
  const action = document.createElement('span');
  action.className = 'dl-toast-action';
  action.textContent = toast.action;
  open.append(action);
  open.addEventListener('click', () => { dismissToast(toast.tag); toast.open(); });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dl-toast-close';
  close.setAttribute('aria-label', toast.closeLabel);
  close.title = toast.closeLabel;
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(toast.tag));

  element.append(open, close);
  root.prepend(element);
  const entry: Shown = { element, left: LIFETIME[toast.kind] ?? Infinity, since: Date.now(), hovered: false };
  element.addEventListener('pointerenter', () => { entry.hovered = true; pause(entry); });
  element.addEventListener('pointerleave', () => { entry.hovered = false; arm(toast.tag, entry); });
  shown.set(toast.tag, entry);
  arm(toast.tag, entry);
  // The oldest go first.
  for (const [tag] of [...shown].slice(0, Math.max(0, shown.size - MAX))) dismissToast(tag);
}

export function dismissToast(tag: string): void {
  const entry = shown.get(tag);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.element.remove();
  shown.delete(tag);
}

/** Close every notice of one machine (it is on screen now). */
export function dismissMachine(machine: string): void {
  for (const tag of [...shown.keys()]) if (tag.startsWith(`dsh-link:${machine}:`)) dismissToast(tag);
}

export function toastCount(): number { return shown.size; }
