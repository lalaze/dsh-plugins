/**
 * A mark on the Status tab while the project has a blocker written down. DSH draws a view's tab from its label alone,
 * the same for every conversation, so the mark is put into the label's element from a component that is always mounted
 * and knows the conversation; an observer puts it back when DSH draws the tabs again. It carries no text, so the tab
 * still reads as its label.
 */
const TABS = '[data-conversation-tabs]', TAB = `${TABS} button[role="tab"]`, MARK = 'data-ps-tab-dot', STYLE = 'dsh-project-status-tab-dot';
const CSS = `.ps-tab-dot{display:inline-block;width:7px;height:7px;margin-left:6px;border-radius:999px;corner-shape:round;vertical-align:middle;background:var(--dsw-alias-state-warn-primary,#e0982e)}`;

let observer: MutationObserver | undefined, observed: HTMLElement | null = null, label = '', shown = false;
/** Two conversations side by side both drive this; the last one to show a mark owns it, and an earlier one cannot clear it. */
let owner: symbol | undefined;

function tabOf(text: string): HTMLButtonElement | null {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(TAB)) if ((tab.textContent ?? '').trim() === text) return tab;
  return null;
}
/** The element holding the label's text: beside it the mark would fall onto the next line of the button. */
function host(tab: HTMLButtonElement, text: string): HTMLElement {
  const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node.nodeValue ?? '').trim() === text && node.parentElement) return node.parentElement;
  return tab;
}
function apply(): void {
  const tab = tabOf(label);
  if (!tab) return;
  const existing = tab.querySelector<HTMLElement>(`[${MARK}]`);
  if (!shown) { existing?.remove(); return; }
  const place = host(tab, label);
  if (existing) { if (existing.parentElement !== place) place.appendChild(existing); return; }
  if (!document.getElementById(STYLE)) {
    const style = document.createElement('style');
    style.id = STYLE; style.textContent = CSS;
    document.head.appendChild(style);
  }
  const dot = document.createElement('span');
  dot.className = 'ps-tab-dot'; dot.setAttribute(MARK, ''); dot.setAttribute('aria-hidden', 'true');
  place.appendChild(dot);
}
function observe(): void {
  if (typeof MutationObserver === 'undefined') return;
  // The input a conversation's component sits in can be there before its tabs are; the page is watched until they come.
  const container = document.querySelector<HTMLElement>(TABS) ?? document.body;
  if (container === observed && container.isConnected) return;
  observer?.disconnect();
  observed = container;
  observer = new MutationObserver(() => {
    if (observed === document.body ? document.querySelector(TABS) : !observed?.isConnected) observe();
    apply();
  });
  observer.observe(container, { childList: true, subtree: true });
}

/** Shows or hides the mark on the tab labelled `text`, on behalf of `who`. */
export function setTabDot(who: symbol, text: string, on: boolean): void {
  if (typeof document === 'undefined') return;
  if (!on) { clearTabDot(who); return; }
  owner = who; label = text; shown = true;
  observe();
  apply();
}
export function clearTabDot(who: symbol): void {
  if (typeof document === 'undefined' || (owner !== undefined && owner !== who)) return;
  owner = undefined; shown = false;
  apply();
  observer?.disconnect();
  observer = undefined; observed = null;
}
