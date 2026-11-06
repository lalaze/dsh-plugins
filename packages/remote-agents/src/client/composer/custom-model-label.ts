import type { ChatProject } from '../../core/domain.js';
import { api } from '../api.js';

/** A custom picker's own caption, or the cell DSH's picker wraps around a remote model's label. */
const CAPTIONS = '.codexModelSelectLabel, [data-provider-id^="remote-cli"]';

/** The caption's text node, however deep its owner nested it. A caption holding anything more is not ours to edit. */
function onlyText(caption: Element): Text | undefined {
  const walker = document.createTreeWalker(caption, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode() as Text | null;
  return text && !walker.nextNode() ? text : undefined;
}

/** The trigger's tooltip is the catalog name, followed by the effort in DSH's own picker. */
const namedBy = (button: Element, full: string) => {
  const title = button.getAttribute('title');
  return title === full || !!title?.startsWith(`${full} · `);
};

/**
 * The native label slot cannot always drop the host: some composer plugins render their own picker
 * without calling it, and in a single slot the lowest priority wins, so another plugin's label
 * (dsh-connect-workbuddy sits at -0.5) shadows ours and prints the full catalog name.
 */
export function installCustomModelLabels(
  load: (signal: AbortSignal) => Promise<ChatProject[]> = signal => api<ChatProject[]>('hostCatalogs', {}, signal),
): () => void {
  if (typeof document === 'undefined') return () => {};
  const changed = new Map<Text, { full: string; short: string; button: Element }>();
  let names = new Map<string, string>(), stopped = false, scheduled = false, request: AbortController | undefined;
  const restore = () => {
    for (const [node, value] of changed) {
      if (node.isConnected && node.data === value.short && namedBy(value.button, value.full)) node.data = value.full;
    }
    changed.clear();
  };
  const scan = () => {
    scheduled = false;
    if (stopped) return;
    for (const node of changed.keys()) if (!node.isConnected) changed.delete(node);
    for (const caption of Array.from(document.querySelectorAll(CAPTIONS))) {
      // Menu rows are not inside a trigger: they keep the host that tells saved hosts apart.
      const button = caption.closest('[aria-haspopup="menu"]'), text = onlyText(caption);
      const full = text?.data, short = full ? names.get(full) : undefined;
      // Edit only the existing text node. Preserve React's child structure, effort, tooltip and controls.
      if (!button || !text || !full || !short || !namedBy(button, full)) continue;
      changed.set(text, { full, short, button }); text.data = short;
    }
  };
  const schedule = () => { if (!scheduled && !stopped) { scheduled = true; queueMicrotask(scan); } };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title'] });
  const refresh = () => {
    request?.abort(); const controller = new AbortController(); request = controller;
    void load(controller.signal).then(projects => {
      if (stopped || controller.signal.aborted) return;
      const next = new Map<string, string>();
      for (const project of projects) for (const provider of project.providers) {
        if (provider.status !== 'ready') continue;
        for (const model of provider.models) for (const tier of [undefined, ...model.serviceTiers ?? []]) {
          const short = `${model.label}${tier ? ` ${tier.label}` : ''}`;
          next.set(`${short} · ${project.label}`, short);
        }
      }
      restore(); names = next; scan();
    }).catch(() => { /* A missing catalog leaves the composer's original label intact. */ });
  };
  const events = ['focus', 'remote-agents-updated'];
  for (const event of events) window.addEventListener(event, refresh);
  refresh();
  return () => {
    stopped = true; request?.abort(); observer.disconnect();
    for (const event of events) window.removeEventListener(event, refresh);
    restore(); names.clear();
  };
}
