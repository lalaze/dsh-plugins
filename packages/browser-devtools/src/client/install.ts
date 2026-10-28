import { DetachedDebugger, type DetachedState, type Inspectable } from './detached.js';
import { i18n, ui } from './i18n.js';

const selector = 'webview[data-sidebar-browser-frame="webview"]';
const messages = {
    open: 'Open debugger in a separate window', close: 'Close debugger window', loading: 'Opening page debugger…',
    waiting: 'The page debugger will be available after the page loads', dismiss: 'Dismiss message',
};
const css = `
.dsh-bdt-button{width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,5px);background:transparent;color:var(--dsw-alias-label-secondary,#aaa);display:inline-flex;flex:none;align-items:center;justify-content:center;cursor:pointer}
.dsh-bdt-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,inherit)}
.dsh-bdt-button[aria-pressed=true]{color:var(--dsw-alias-state-business-primary,#557bff)}
.dsh-bdt-button:disabled{opacity:.45;cursor:default}
.dsh-bdt-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#557bff);outline-offset:1px}
.dsh-bdt-notice{display:flex;align-items:center;gap:8px;flex:none;padding:8px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,#8882)}
.dsh-bdt-notice[hidden]{display:none}.dsh-bdt-notice span{flex:1;overflow-wrap:anywhere}
`;

/** DSH rc.2 has no toolbar slot. Match its explicit frame marker and local form,
 * never translated labels, generated CSS class names, or another tab's toolbar. */
function toolbarFor(view: Element): HTMLFormElement | undefined {
  for (let parent = view.parentElement; parent && parent !== view.ownerDocument.body; parent = parent.parentElement) {
    const forms = Array.from(parent.children).filter((child): child is HTMLFormElement => child.tagName === 'FORM');
    if (forms.length === 1 && forms[0].querySelector('input') && parent.querySelectorAll(selector).length === 1) return forms[0];
    if (parent.querySelectorAll(selector).length > 1) return undefined;
  }
}

export function installDevTools(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const entries = new Map<Element, { toolbar: HTMLFormElement; button: HTMLButtonElement; notice: HTMLDivElement; render(): void; dispose(): void }>();
  const style = doc.createElement('style');
  style.dataset.dshBrowserDevtools = '';
  style.textContent = css;
  doc.head.append(style);
  let stopped = false;
  let queued = false;

  const scan = () => {
    queued = false;
    if (stopped) return;
    for (const [view, entry] of entries) {
      if (!view.isConnected || toolbarFor(view) !== entry.toolbar) {
        entry.dispose(); entries.delete(view);
      } else {
        if (entry.button.parentElement !== entry.toolbar) entry.toolbar.append(entry.button);
        if (entry.notice.previousElementSibling !== entry.toolbar) entry.toolbar.after(entry.notice);
      }
    }
    for (const element of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
      if (entries.has(element)) continue;
      const view = element as HTMLElement & Partial<Inspectable>;
      if (typeof view.executeJavaScript !== 'function' || typeof view.getURL !== 'function') continue;
      const toolbar = toolbarFor(element);
      if (!toolbar) continue;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'dsh-bdt-button';
      button.dataset.dshBrowserDevtools = 'detach';
      // Fixed icon markup, never page content.
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>';
      const notice = doc.createElement('div');
      notice.className = 'dsh-bdt-notice';
      notice.hidden = true;
      notice.setAttribute('role', 'alert');
      const description = doc.createElement('span');
      const dismiss = doc.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'dsh-bdt-button';
      dismiss.textContent = '×';
      notice.append(description, dismiss);
      let state: DetachedState = { opened: false, busy: false };
      const ready = (): boolean => { try { return /^https?:\/\//i.test((view as Inspectable).getURL()); } catch { return false; } };
      const render = () => {
        dismiss.setAttribute('aria-label', ui(messages.dismiss));
        const label = state.opened ? messages.close : messages.open;
        // An open window can always be closed, even while its page navigates.
        const waiting = !state.opened && !ready();
        button.disabled = state.busy || waiting;
        button.setAttribute('aria-pressed', String(state.opened));
        button.setAttribute('aria-busy', String(state.busy));
        button.setAttribute('aria-label', ui(label));
        button.title = ui(state.busy ? messages.loading : waiting ? messages.waiting : label);
        notice.hidden = !state.error;
        const message = state.error ? ui(state.error) : '';
        if (description.textContent !== message) description.textContent = message;
      };
      const detached = new DetachedDebugger(doc, view as HTMLElement & Inspectable, next => { state = next; render(); });
      const pageEvents = ['dom-ready', 'did-navigate', 'did-stop-loading'];
      const click = (event: Event) => {
        event.preventDefault(); event.stopPropagation();
        void (detached.opened ? detached.close() : detached.open());
      };
      const dismissClick = () => { detached.dismiss(); button.focus(); };
      for (const event of pageEvents) view.addEventListener(event, render);
      button.addEventListener('click', click);
      dismiss.addEventListener('click', dismissClick);
      toolbar.append(button);
      toolbar.after(notice);
      render();
      entries.set(element, { toolbar, button, notice, render, dispose() {
        detached.dispose();
        for (const event of pageEvents) view.removeEventListener(event, render);
        button.removeEventListener('click', click);
        dismiss.removeEventListener('click', dismissClick);
        button.remove(); notice.remove();
      } });
    }
  };
  const observer = new win.MutationObserver(() => {
    if (queued || stopped) return;
    queued = true;
    win.queueMicrotask(scan);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  const unsubscribe = i18n.subscribe(() => { for (const entry of entries.values()) entry.render(); });
  scan();
  return () => {
    stopped = true;
    unsubscribe();
    observer.disconnect();
    for (const entry of entries.values()) entry.dispose();
    entries.clear(); style.remove();
  };
}
