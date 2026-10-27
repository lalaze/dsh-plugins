import { MAX_SOURCE_LENGTH } from '../rpc.js';
import { loadSettings, subscribeSettings, translate } from './api.js';
import { messageSelector } from './dom.js';
import { i18n, localizeError, ui } from './i18n.js';

// Overlays live outside DSH's message tree, so re-rendering or streaming a message never fights with them.
const blockSelector = 'p, li, h1, h2, h3, h4, h5, h6, blockquote';
const skipSelector = 'pre, code, textarea, [contenteditable="true"], [data-dsh-translate-paragraph]';
const BUTTON = 20, GAP = 4;
export const TRANSLATE_ICON_PATH = 'M1.5 3.5h7M5 2v1.5M3 3.5c.6 2.4 2.1 4.2 4.4 5.4M7 3.5C6.4 6.1 4.7 8.3 2 9.5M8.5 14l3-7 3 7M9.6 11.6h3.8';
const icon = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${TRANSLATE_ICON_PATH}"/></svg>`;
const spinner = '<svg class="dsh-translate-spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6" opacity="0.25"/><path d="M14 8a6 6 0 0 0-6-6"/></svg>';

interface Card { block: Element; element: HTMLElement; body: HTMLElement }

/** The innermost translatable block under `target` inside a chat message. */
function blockAt(target: EventTarget | null): Element | null {
  if (!(target instanceof Element) || target.closest(skipSelector)) return null;
  const block = target.closest(blockSelector);
  return block && block.closest(messageSelector) ? block : null;
}
/** A block's own text: nested lists and code are their own blocks or not translated. */
function textOf(block: Element): string {
  const clone = block.cloneNode(true) as Element;
  clone.querySelectorAll('ul, ol, pre').forEach(node => node.remove());
  clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  return (clone.textContent ?? '').trim();
}
/** The visible region of the block's scrolling ancestor, so overlays never float over the composer or sidebar. */
function area(block: Element): { top: number; bottom: number; left: number; right: number } {
  for (let node = block.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node.getBoundingClientRect();
  }
  return { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
}
/** Lists and quotes draw markers left of their items; the button sits outside them. */
function gutter(block: Element): number {
  const message = block.closest(messageSelector);
  let left = block.getBoundingClientRect().left;
  for (let node = block.parentElement; node && node !== message; node = node.parentElement) if (node.matches('ul, ol, blockquote')) left = Math.min(left, node.getBoundingClientRect().left);
  return left;
}

function attach(): () => void {
  const cards = new Map<Element, Card>();
  let hovered: Element | null = null, hideTimer: ReturnType<typeof setTimeout> | undefined, frame = 0;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'dsh-translate-paragraph-button'; button.dataset.dshTranslateParagraph = ''; button.hidden = true; button.innerHTML = icon;
  const label = () => { const text = ui(hovered && cards.has(hovered) ? 'Hide translation' : 'Translate paragraph'); button.title = text; button.setAttribute('aria-label', text); button.toggleAttribute('data-open', !!hovered && cards.has(hovered)); };
  document.body.append(button);

  const placeButton = () => {
    if (!hovered || !hovered.isConnected) { hideButton(); return; }
    const rect = hovered.getBoundingClientRect(), bounds = area(hovered), style = getComputedStyle(hovered);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || BUTTON;
    const top = rect.top + Math.max(0, (Math.min(line, rect.height) - BUTTON) / 2);
    if (top < bounds.top || top + BUTTON > bounds.bottom) { button.hidden = true; return; }
    Object.assign(button.style, { left: `${Math.max(bounds.left + 2, gutter(hovered) - BUTTON - GAP)}px`, top: `${top}px` });
    button.hidden = false;
  };
  const placeCard = (card: Card) => {
    if (!card.block.isConnected) { close(card); return; }
    const rect = card.block.getBoundingClientRect(), bounds = area(card.block), element = card.element;
    const visible = rect.bottom > bounds.top && rect.top < bounds.bottom;
    element.style.visibility = visible ? '' : 'hidden';
    if (!visible) return;
    const width = Math.min(Math.max(rect.width, 280), 620, innerWidth - 12);
    element.style.width = `${width}px`;
    element.style.left = `${Math.min(Math.max(6, rect.left), innerWidth - width - 6)}px`;
    // Below the paragraph by default; above it when the bottom of the conversation has no room.
    const height = element.offsetHeight, below = rect.bottom + 6, above = rect.top - 6 - height;
    element.style.top = `${below + height <= bounds.bottom || above < bounds.top ? below : above}px`;
  };
  const place = () => { frame = 0; placeButton(); for (const card of [...cards.values()]) placeCard(card); };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  // Streaming text moves paragraphs without scrolling; follow layout changes only while something is shown.
  const observer = new MutationObserver(schedule);
  const observe = () => { observer.disconnect(); if (cards.size || !button.hidden) observer.observe(document.body, { childList: true, subtree: true, characterData: true }); };

  function hideButton() { clearTimeout(hideTimer); hovered = null; button.hidden = true; observe(); }
  function close(card: Card) { card.element.remove(); if (cards.get(card.block) === card) cards.delete(card.block); label(); observe(); }
  function open(block: Element) {
    const element = document.createElement('div'), body = document.createElement('div'), dismiss = document.createElement('button');
    element.className = 'dsh-translate-paragraph-card'; element.dataset.dshTranslateParagraph = ''; element.dataset.state = 'busy'; element.setAttribute('role', 'status');
    body.innerHTML = spinner; body.append(ui('Translating…'));
    dismiss.type = 'button'; dismiss.className = 'dsh-translate-paragraph-close'; dismiss.textContent = '×'; dismiss.title = ui('Close'); dismiss.setAttribute('aria-label', ui('Close'));
    const card: Card = { block, element, body };
    dismiss.addEventListener('click', () => close(card));
    element.append(body, dismiss); document.body.append(element); cards.set(block, card);
    placeCard(card); label(); observe();
    const text = textOf(block);
    const settle = (state: 'done' | 'error', value: string) => { if (cards.get(block) !== card) return; element.dataset.state = state; body.textContent = value; placeCard(card); };
    if (!text || text.length > MAX_SOURCE_LENGTH) { settle('error', localizeError('Text must contain 1–5,000 characters')); return; }
    void translate(text, 'auto', loadSettings()).then(result => settle('done', result.translation), error => settle('error', localizeError(error instanceof Error ? error.message : String(error))));
  }

  const onOver = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || event.buttons) return;
    if (event.target instanceof Element && event.target.closest('.dsh-translate-paragraph-button')) { clearTimeout(hideTimer); return; }
    const block = blockAt(event.target);
    if (!block || !textOf(block)) { clearTimeout(hideTimer); hideTimer = setTimeout(hideButton, 250); return; }
    clearTimeout(hideTimer);
    if (block !== hovered) { hovered = block; label(); placeButton(); observe(); }
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && cards.size) { for (const card of [...cards.values()]) close(card); } };
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => { if (!hovered) return; const card = cards.get(hovered); if (card) close(card); else open(hovered); });
  document.addEventListener('pointerover', onOver); document.addEventListener('keydown', onKey);
  document.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule);
  const unsubscribe = i18n.subscribe(label);
  return () => {
    unsubscribe(); observer.disconnect(); clearTimeout(hideTimer); if (frame) cancelAnimationFrame(frame);
    document.removeEventListener('pointerover', onOver); document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule);
    for (const card of cards.values()) card.element.remove();
    button.remove();
  };
}

/** A translate button beside each paragraph of a chat message, following the saved on/off setting. */
export function installParagraphTranslation(): () => void {
  let detach: (() => void) | undefined;
  const sync = () => {
    const enabled = loadSettings().paragraphTranslate;
    if (enabled && !detach) detach = attach();
    else if (!enabled && detach) { detach(); detach = undefined; }
  };
  sync();
  const unsubscribe = subscribeSettings(sync);
  return () => { unsubscribe(); detach?.(); };
}
