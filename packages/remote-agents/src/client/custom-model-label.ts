import type { ChatProject } from '../domain.js';
import { api } from './api.js';

/** Some composer plugins render their own picker without calling the native model-label slot. */
export function installCustomModelLabels(
  load: (signal: AbortSignal) => Promise<ChatProject[]> = signal => api<ChatProject[]>('hostCatalogs', {}, signal),
): () => void {
  if (typeof document === 'undefined') return () => {};
  const changed = new Map<Text, { full: string; short: string; button: Element }>();
  let names = new Map<string, string>(), stopped = false, scheduled = false, request: AbortController | undefined;
  const restore = () => {
    for (const [node, value] of changed) {
      if (node.isConnected && node.data === value.short && value.button.getAttribute('title') === value.full) node.data = value.full;
    }
    changed.clear();
  };
  const scan = () => {
    scheduled = false;
    if (stopped) return;
    for (const node of changed.keys()) if (!node.isConnected) changed.delete(node);
    for (const button of Array.from(document.querySelectorAll('.codexModelSelectTrigger[aria-haspopup="menu"]'))) {
      const full = button.getAttribute('title'), short = full ? names.get(full) : undefined;
      const label = button.querySelector('.codexModelSelectLabel'), node = label?.firstChild;
      // Edit only an existing plain text node. Preserve React's child structure, effort, tooltip and controls.
      if (!full || !short || label?.childNodes.length !== 1 || node?.nodeType !== Node.TEXT_NODE) continue;
      const text = node as Text;
      if (text.data !== full) continue;
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
