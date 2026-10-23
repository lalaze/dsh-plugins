import { controlDevTools, type Inspectable } from './control.js';

const selector = 'webview[data-sidebar-browser-frame="webview"]';
const messages = {
  zh: {
    open: '打开调试浮窗', close: '关闭调试浮窗', loading: '正在打开调试浮窗…',
    waiting: '网页加载后可打开调试浮窗', dismiss: '关闭提示',
    unavailable: '当前网页尚未准备好调试浮窗，请重新加载网页后再试。',
    failed: '无法在当前网页打开调试浮窗，请重新加载网页后再试。',
  },
  en: {
    open: 'Open page debugger', close: 'Close page debugger', loading: 'Opening page debugger…',
    waiting: 'The page debugger will be available after the page loads', dismiss: 'Dismiss message',
    unavailable: 'The page is not ready for the debugger. Reload the page and try again.',
    failed: 'Could not open the in-page debugger. Reload the page and try again.',
  },
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
  const entries = new Map<Element, { toolbar: HTMLFormElement; button: HTMLButtonElement; notice: HTMLDivElement; dispose(): void }>();
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
      const text = /^(zh)(-|_|$)/i.test(doc.documentElement.lang || win.navigator.language) ? messages.zh : messages.en;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'dsh-bdt-button';
      button.dataset.dshBrowserDevtools = 'toggle';
      // Fixed icon markup, never page content.
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 12l-3 3 3 3m6-6 3 3-3 3"/></svg>';
      const notice = doc.createElement('div');
      notice.className = 'dsh-bdt-notice';
      notice.hidden = true;
      notice.setAttribute('role', 'alert');
      const description = doc.createElement('span');
      const dismiss = doc.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'dsh-bdt-button';
      dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', text.dismiss);
      notice.append(description, dismiss);
      const control = controlDevTools(view as HTMLElement & Inspectable, state => {
        button.disabled = !state.ready || state.busy;
        button.setAttribute('aria-pressed', String(state.opened));
        button.setAttribute('aria-busy', String(state.busy));
        button.setAttribute('aria-label', state.opened ? text.close : text.open);
        button.title = !state.ready ? text.waiting : state.busy ? text.loading : state.opened ? text.close : text.open;
        notice.hidden = !state.error;
        const message = state.error ? text[state.error] : '';
        if (description.textContent !== message) description.textContent = message;
      });
      const click = (event: Event) => { event.preventDefault(); event.stopPropagation(); control.toggle(); };
      const dismissClick = () => { control.dismiss(); button.focus(); };
      button.addEventListener('click', click);
      dismiss.addEventListener('click', dismissClick);
      toolbar.append(button);
      toolbar.after(notice);
      entries.set(element, { toolbar, button, notice, dispose() {
        control.dispose();
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
  scan();
  return () => {
    stopped = true;
    observer.disconnect();
    for (const entry of entries.values()) entry.dispose();
    entries.clear(); style.remove();
  };
}
