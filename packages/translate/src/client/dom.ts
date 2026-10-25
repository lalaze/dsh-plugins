import { loadSettings, translate } from './api.js';
import { i18n, localizeError, ui } from './i18n.js';

const messageSelector = '[data-testid="assistant-message"], [data-testid="user-message"], [data-message-role="assistant"], [data-message-role="user"]';
const overlaySelector = '[data-dsh-translate-overlay]';

function selectedMessage(selection: Selection): Element | null {
  const node = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  const other = selection.focusNode instanceof Element ? selection.focusNode : selection.focusNode?.parentElement;
  const message = node?.closest(messageSelector) ?? null;
  return message && other?.closest(messageSelector) === message ? message : null;
}
function removeOverlays() { document.querySelectorAll(overlaySelector).forEach(node => node.remove()); }
function button(text: string, title: string) { const value = document.createElement('button'); value.type = 'button'; value.textContent = text; value.title = title; value.dataset.dshTranslateOverlay = ''; Object.assign(value.style, { position: 'fixed', zIndex: '2147483000', border: '1px solid #52525b', borderRadius: '6px', padding: '5px 9px', background: '#27272a', color: '#f4f4f5', cursor: 'pointer', boxShadow: '0 4px 18px #0006' }); return value; }
function readComposer(): HTMLElement | null { return document.querySelector<HTMLElement>('[data-composer-input], textarea[aria-label*="message" i], textarea[placeholder*="message" i], textarea[placeholder*="消息" i], [contenteditable="true"]'); }
export function composerText(element: HTMLElement): string { return element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : (element.innerText || element.textContent || ''); }
export function replaceComposer(element: HTMLElement, value: string): void { if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter?.call(element, value); } else { element.textContent = value; } element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); element.focus(); }

export function installTranslationDom(): () => void {
  let disposed = false; let selected = ''; let anchor: DOMRect | undefined; let request = 0;
  const hide = () => { selected = ''; anchor = undefined; removeOverlays(); };
  const onSelection = () => { if (disposed) return; const selection = window.getSelection(); if (!selection || selection.isCollapsed) { return; } const message = selectedMessage(selection); const text = selection.toString().trim(); if (!message || !text || text.length > 5000) return; selected = text; const range = selection.getRangeAt(0); anchor = range.getBoundingClientRect(); document.querySelectorAll(`${overlaySelector}[data-selection-control]`).forEach(node => node.remove()); const control = button(ui('Translate'), ui('Translate selection')); control.dataset.selectionControl = ''; const rect = anchor; Object.assign(control.style, { left: `${Math.max(6, rect.left)}px`, top: `${Math.max(6, rect.bottom + 8)}px` }); control.addEventListener('mousedown', event => event.preventDefault()); control.addEventListener('click', () => { const textAtClick = selected; const current = ++request; control.disabled = true; control.textContent = ui('Translating…'); void translate(textAtClick, 'auto', loadSettings()).then(result => { if (disposed || current !== request) return; const output = document.createElement('div'); output.dataset.dshTranslateOverlay = ''; output.setAttribute('role', 'status'); output.textContent = result.translation; Object.assign(output.style, { position: 'fixed', zIndex: '2147483000', left: `${Math.max(6, rect.left)}px`, top: `${Math.max(6, rect.bottom + 42)}px`, maxWidth: 'min(620px, calc(100vw - 12px))', maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', padding: '9px 12px', borderRadius: '7px', background: '#18181b', color: '#f4f4f5', border: '1px solid #52525b', boxShadow: '0 8px 24px #0008' }); document.body.append(output); control.remove(); setTimeout(() => output.isConnected && output.remove(), 12000); }).catch(error => { control.disabled = false; control.textContent = localizeError(error); }); }); document.body.append(control); };
  const onPointer = (event: PointerEvent) => { const target = event.target as Element | null; if (!target?.closest(overlaySelector) && !target?.closest(messageSelector)) hide(); };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); if (event.altKey && event.key.toLowerCase() === 't') { const editor = readComposer(); if (editor) { event.preventDefault(); void translateDraft(editor); } } };
  document.addEventListener('mouseup', onSelection); document.addEventListener('pointerdown', onPointer); document.addEventListener('keydown', onKey); document.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
  const unsubscribe = i18n.subscribe(() => { document.querySelectorAll(`${overlaySelector}[data-selection-control]`).forEach(node => node.remove()); refreshDraftButton(); });
  return () => { unsubscribe(); disposed = true; request++; document.removeEventListener('mouseup', onSelection); document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); document.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); hide(); };
}

export async function translateDraft(editor: HTMLElement): Promise<void> { const original = composerText(editor).trim(); if (!original || original.length > 5000) return; const button = document.querySelector<HTMLButtonElement>('[data-dsh-translate-draft]'); if (button) { button.dataset.dshTranslateBusy = ''; delete button.dataset.dshTranslateError; button.disabled = true; button.textContent = ui('Translating…'); } try { const result = await translate(original, 'auto', loadSettings()); if (composerText(editor).trim() === original) replaceComposer(editor, result.translation); if (button) { delete button.dataset.dshTranslateBusy; button.disabled = false; button.textContent = ui('Undo'); button.dataset.dshTranslateUndo = original; } } catch (error) { if (button) { delete button.dataset.dshTranslateBusy; button.dataset.dshTranslateError = error instanceof Error ? error.message : String(error); button.disabled = false; button.textContent = localizeError(error); setTimeout(() => { if (button.isConnected) { delete button.dataset.dshTranslateError; refreshDraftButton(); } }, 3000); } } }

/** DOM translation actions keep their current state when the host language changes. */
export function refreshDraftButton(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-dsh-translate-draft]');
  if (!button) return;
  button.textContent = button.dataset.dshTranslateBusy !== undefined ? ui('Translating…') : button.dataset.dshTranslateError ? localizeError(button.dataset.dshTranslateError) : button.dataset.dshTranslateUndo !== undefined ? ui('Undo') : ui('Translate');
  button.title = ui('Translate draft (Alt/Option+T)');
}
