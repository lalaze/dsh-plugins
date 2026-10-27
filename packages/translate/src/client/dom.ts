import { loadSettings, translate } from './api.js';
import { i18n, localizeError, ui } from './i18n.js';

// DSH 0.2.x renders each chat item as a `conversation.chat.node` slot inside a keyed flow item; the rest cover other builds.
export const messageSelector = '[data-slot="conversation.chat.node"], [data-chat-node-key], [data-testid="assistant-message"], [data-testid="user-message"], [data-message-role="assistant"], [data-message-role="user"]';
const overlaySelector = '[data-dsh-translate-overlay]';

function selectedMessage(selection: Selection): Element | null {
  const node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  const other = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement;
  const message = node?.closest(messageSelector) ?? null;
  return message && other?.closest(messageSelector) === message ? message : null;
}
/** A double-click selection worth translating as one word: no spaces, short, with at least one letter. */
export const isWord = (text: string) => text.length <= 48 && !/\s/.test(text) && /\p{L}/u.test(text);
function removeOverlays() { document.querySelectorAll(overlaySelector).forEach(node => node.remove()); }
function button(text: string, title: string) { const value = document.createElement('button'); value.type = 'button'; value.textContent = text; value.title = title; value.dataset.dshTranslateOverlay = ''; Object.assign(value.style, { position: 'fixed', zIndex: '2147483000', border: '1px solid #52525b', borderRadius: '6px', padding: '5px 9px', background: '#27272a', color: '#f4f4f5', cursor: 'pointer', boxShadow: '0 4px 18px #0006' }); return value; }
export const composerScope = '[data-composer-card], [data-composer-seat], form';
const composerSelector = 'textarea[data-composer-input], input[data-composer-input], [data-composer-input] textarea, [data-input-scroll] textarea, textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="消息" i], [contenteditable="true"]';
function editable(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]') && !element.matches(':disabled, [readonly]');
}
/** Prefer the input beside the action; inactive sessions can keep their inputs mounted. */
export function readComposer(origin?: Element | null): HTMLElement | null {
  const scope = origin?.closest(composerScope);
  const local = scope?.querySelectorAll<HTMLElement>('textarea, input[data-composer-input], [contenteditable="true"]');
  if (local) return Array.from(local).find(editable) ?? null;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.matches(composerSelector) && editable(focused)) return focused;
  return Array.from(document.querySelectorAll<HTMLElement>(composerSelector)).find(editable) ?? null;
}
export function composerText(element: HTMLElement): string { return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : (element.innerText || element.textContent || ''); }
export function replaceComposer(element: HTMLElement, value: string): void { if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; setter?.call(element, value); } else { element.textContent = value; } element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); element.focus(); }

export function installTranslationDom(): () => void {
  let disposed = false; let selected = ''; let anchor: DOMRect | undefined; let request = 0;
  const hide = () => { selected = ''; anchor = undefined; removeOverlays(); };
  const onSelection = (event: MouseEvent) => { if (disposed) return; const selection = window.getSelection(); if (!selection || selection.isCollapsed) { return; } const message = selectedMessage(selection); const text = selection.toString().trim(); if (!message || !text || text.length > 5000) return; if (event.detail === 2 && isWord(text) && loadSettings().paragraphTranslate) return; // Word double-clicks open a card directly.
    selected = text; const range = selection.getRangeAt(0); anchor = range.getBoundingClientRect(); document.querySelectorAll(`${overlaySelector}[data-selection-control]`).forEach(node => node.remove()); const control = button(ui('Translate'), ui('Translate selection')); control.dataset.selectionControl = ''; const rect = anchor; Object.assign(control.style, { left: `${Math.max(6, rect.left)}px`, top: `${Math.max(6, rect.bottom + 8)}px` }); control.addEventListener('mousedown', event => event.preventDefault()); control.addEventListener('click', () => { const textAtClick = selected; const current = ++request; control.disabled = true; control.textContent = ui('Translating…'); void translate(textAtClick, 'auto', loadSettings()).then(result => { if (disposed || current !== request) return; const output = document.createElement('div'); output.dataset.dshTranslateOverlay = ''; output.setAttribute('role', 'status'); output.textContent = result.translation; Object.assign(output.style, { position: 'fixed', zIndex: '2147483000', left: `${Math.max(6, rect.left)}px`, top: `${Math.max(6, rect.bottom + 42)}px`, maxWidth: 'min(620px, calc(100vw - 12px))', maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', padding: '9px 12px', borderRadius: '7px', background: '#18181b', color: '#f4f4f5', border: '1px solid #52525b', boxShadow: '0 8px 24px #0008' }); document.body.append(output); control.remove(); setTimeout(() => output.isConnected && output.remove(), 12000); }).catch(error => { control.disabled = false; control.textContent = localizeError(error); }); }); document.body.append(control); };
  const onPointer = (event: PointerEvent) => { const target = event.target as Element | null; if (!target?.closest(overlaySelector) && !target?.closest(messageSelector)) hide(); };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
  document.addEventListener('mouseup', onSelection); document.addEventListener('pointerdown', onPointer); document.addEventListener('keydown', onKey); document.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
  const unsubscribe = i18n.subscribe(() => { document.querySelectorAll(`${overlaySelector}[data-selection-control]`).forEach(node => node.remove()); });
  return () => { unsubscribe(); disposed = true; request++; document.removeEventListener('mouseup', onSelection); document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); document.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); hide(); };
}
