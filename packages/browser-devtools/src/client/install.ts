import { controlDevTools, type Inspectable, type State } from './control.js';
import { DebuggerPanel, type PanelView } from './panel.js';
import { DetachedDebugger, type DetachedState } from './detached.js';
import { i18n, ui } from './i18n.js';

const selector = 'webview[data-sidebar-browser-frame="webview"]';
const messages = {
    open: 'Open page debugger', close: 'Close page debugger', closeNative: 'Close DevTools', loading: 'Opening page debugger…',
    waiting: 'The page debugger will be available after the page loads', dismiss: 'Dismiss message',
    unavailable: 'The debugger cannot dock in this browser view. Update the plugin or DSH and try again.',
    failed: 'Could not open the page debugger. Reload the page and try again.',
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
  const entries = new Map<Element, { toolbar: HTMLFormElement; button: HTMLButtonElement; detachedButton: HTMLButtonElement; notice: HTMLDivElement; render(): void; localize(): void; dispose(): void }>();
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
        if (entry.detachedButton.parentElement !== entry.toolbar) entry.toolbar.append(entry.detachedButton);
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
      button.dataset.dshBrowserDevtools = 'toggle';
      // Fixed icon markup, never page content.
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 12l-3 3 3 3m6-6 3 3-3 3"/></svg>';
      const detachedButton = button.cloneNode(true) as HTMLButtonElement;
      detachedButton.dataset.dshBrowserDevtools = 'detach';
      detachedButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>';
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
      let latest: State;
      let external: DetachedState = { opened: false, busy: false };
      let switching = false;
      const render = (state = latest) => {
        latest = state;
        dismiss.setAttribute('aria-label', ui(messages.dismiss));
        const label = state.native ? messages.closeNative : state.opened ? messages.close : messages.open;
        // An open debugger can always be closed, even while its page navigates.
        button.disabled = switching || external.busy || state.busy || (!state.ready && !state.opened && !state.native);
        button.setAttribute('aria-pressed', String(state.opened || state.native));
        button.setAttribute('aria-busy', String(state.busy));
        button.setAttribute('aria-label', ui(label));
        button.title = ui(state.busy ? messages.loading : state.opened || state.native ? label : !state.ready ? messages.waiting : label);
        const externalLabel = external.opened ? 'Close debugger window' : 'Open debugger in a separate window';
        detachedButton.disabled = switching || state.busy || external.busy || (!state.ready && !external.opened);
        detachedButton.setAttribute('aria-pressed', String(external.opened));
        detachedButton.setAttribute('aria-busy', String(external.busy));
        detachedButton.setAttribute('aria-label', ui(externalLabel));
        detachedButton.title = ui(external.busy ? messages.loading : externalLabel);
        notice.hidden = !state.error && !external.error;
        const message = external.error ? ui(external.error) : state.error ? ui(messages[state.error]) : '';
        if (description.textContent !== message) description.textContent = message;
      };
      let control: ReturnType<typeof controlDevTools> | undefined;
      const panel = new DebuggerPanel(doc, view as unknown as PanelView, () => control?.sync());
      control = controlDevTools(view as HTMLElement & Inspectable, panel, render);
      const detached = new DetachedDebugger(doc, view as HTMLElement & Inspectable, state => { external = state; render(); });
      const toggle = async (separate: boolean) => {
        if (switching) return;
        switching = true; render();
        try {
          if (separate) {
            if (detached.opened) await detached.close();
            else {
              panel.close(); control?.sync();
              try { view.closeDevTools?.(); } catch { /* Already closed. */ }
              await detached.open();
            }
          } else { await detached.close(); await control?.toggle(); }
        } finally { switching = false; render(); }
      };
      const click = (event: Event) => { event.preventDefault(); event.stopPropagation(); void toggle(false); };
      const detachClick = (event: Event) => { event.preventDefault(); event.stopPropagation(); void toggle(true); };
      const dismissClick = () => { detached.dismiss(); control?.dismiss(); button.focus(); };
      button.addEventListener('click', click);
      detachedButton.addEventListener('click', detachClick);
      dismiss.addEventListener('click', dismissClick);
      toolbar.append(button, detachedButton);
      toolbar.after(notice);
      entries.set(element, { toolbar, button, detachedButton, notice, render, localize: () => { render(); panel.localize(); }, dispose() {
        detached.dispose();
        panel.dispose();
        control?.dispose();
        button.removeEventListener('click', click);
        dismiss.removeEventListener('click', dismissClick);
        detachedButton.removeEventListener('click', detachClick);
        detachedButton.remove(); button.remove(); notice.remove();
      } });
    }
  };
  const observer = new win.MutationObserver(() => {
    if (queued || stopped) return;
    queued = true;
    win.queueMicrotask(scan);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  const unsubscribe = i18n.subscribe(() => { for (const entry of entries.values()) entry.localize(); });
  scan();
  return () => {
    stopped = true;
    unsubscribe();
    observer.disconnect();
    for (const entry of entries.values()) entry.dispose();
    entries.clear(); style.remove();
  };
}
