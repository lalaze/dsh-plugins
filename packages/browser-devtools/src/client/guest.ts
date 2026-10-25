export type GuestCommand = 'open' | 'close' | 'state';
export interface GuestState { opened: boolean; available?: boolean }

/**
 * This function is serialized and evaluated inside the selected Electron
 * webview. Keep all helpers inside it: the guest has no access to this
 * extension's JavaScript realm or module loader.
 */
export function guestController(command: GuestCommand, language: 'en' | 'zh' = 'en'): GuestState {
  const key = '__DSH_BROWSER_DEVTOOLS__';
  // `any` is intentional here. The function is compiled into a string and
  // evaluated in a different realm, where Electron's webview owns the types.
  const page = globalThis as any;
  const document = page.document;
  if (!document || !document.documentElement) return { opened: false, available: false };

  const existing = page[key];
  existing?.setLocale?.(language);
  if (command === 'state') return { opened: Boolean(existing?.opened), available: true };
  if (command === 'close') {
    existing?.close();
    return { opened: false, available: true };
  }
  if (existing) {
    existing.open();
    return { opened: existing.opened, available: true };
  }
  if (!document.body) return { opened: false, available: false };

  const logs: Array<{ level: string; time: number; values: unknown[] }> = [];
  const network: Array<{ kind: string; method: string; url: string; status: string; time: number; duration: number }> = [];
  const originalConsole: Record<string, (...args: unknown[]) => void> = {};
  const originalFetch = page.fetch;
  const OriginalXHR = page.XMLHttpRequest;
  const originalXHROpen = OriginalXHR?.prototype.open;
  const originalXHRSend = OriginalXHR?.prototype.send;
  const xhrMeta = new WeakMap<object, { method: string; url: string; entry?: any }>();
  const listeners: Array<[string, EventListener]> = [];
  const pageWindow = document.defaultView;
  const root = document.createElement('aside');
  const style = document.createElement('style');
  const pickOverlay = document.createElement('div');
  let selected: Element | null = null;
  let highlighted: Element | null = null;
  let picking = false;
  let activeTab = 'elements';
  let closed = false;
  let locale = language;
  const ui = (en: string, zh: string) => locale === 'zh' ? zh : en;

  const text = (value: unknown): string => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (typeof value === 'undefined') return 'undefined';
    if (typeof value === 'bigint') return `${String(value)}n`;
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
        }
        if (typeof item === 'bigint') return `${String(item)}n`;
        return item;
      }, 2) ?? String(value);
    } catch { return String(value); }
  };
  const schedule = (() => { let pending = false; return (render: () => void) => {
    if (pending) return; pending = true;
    pageWindow?.requestAnimationFrame(() => { pending = false; if (root.isConnected) render(); });
  }; })();
  const el = (tag: string, className?: string): HTMLElement => {
    const node = document.createElement(tag); if (className) node.className = className; return node;
  };
  const clear = (node: Element) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const formatElement = (node: Element): string => {
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : '';
    const classes = typeof node.className === 'string' && node.className.trim()
      ? `.${node.className.trim().split(/\s+/).slice(0, 4).join('.')}` : '';
    return `${tag}${id}${classes}`;
  };
  const describe = (node: Element | null): string => {
    if (!node) return ui('No element selected', '未选择元素');
    const attrs = Array.from(node.attributes).map(attribute => `${attribute.name}="${attribute.value}"`).join(' ');
    const html = node.outerHTML.length > 1600 ? `${node.outerHTML.slice(0, 1600)}…` : node.outerHTML;
    const computed = pageWindow?.getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return `${formatElement(node)}\n${attrs || ui('(no attributes)', '（无属性）')}\n\n${html}\n\n${ui('size', '尺寸')}: ${Math.round(box.width)} × ${Math.round(box.height)}\ndisplay: ${computed?.display ?? ui('unknown', '未知')}\ncolor: ${computed?.color ?? ui('unknown', '未知')}`;
  };
  const recordLog = (level: string, values: unknown[]) => {
    logs.push({ level, values, time: Date.now() }); if (logs.length > 200) logs.shift();
    schedule(renderConsole);
  };
  const addNetwork = (entry: any) => {
    network.push(entry); if (network.length > 200) network.shift(); schedule(renderNetwork);
  };
  const urlOf = (input: unknown): string => {
    try { return new page.URL(typeof input === 'string' ? input : String((input as any)?.url ?? input), page.location.href).href; }
    catch { return String(input); }
  };
  const renderConsole = () => {
    const list = root.querySelector('[data-dsh-list="console"]'); if (!list) return; clear(list);
    for (const entry of logs) {
      const row = el('div', `dsh-bdt-log dsh-bdt-log-${entry.level}`);
      const stamp = el('time', 'dsh-bdt-time'); stamp.textContent = new Date(entry.time).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US');
      const value = el('pre'); value.textContent = entry.values.map(text).join(' '); row.append(stamp, value); list.append(row);
    }
    if (logs.length === 0) { const empty = el('p', 'dsh-bdt-empty'); empty.textContent = ui('Console is empty', '控制台暂无日志'); list.append(empty); }
    (list as HTMLElement).scrollTop = list.scrollHeight;
  };
  const renderNetwork = () => {
    const list = root.querySelector('[data-dsh-list="network"]'); if (!list) return; clear(list);
    for (const entry of network) {
      const row = el('div', 'dsh-bdt-network');
      const heading = el('strong'); heading.textContent = `${entry.method}  ${entry.status || '…'}`;
      const url = el('span'); url.textContent = entry.url;
      const meta = el('small'); meta.textContent = `${entry.kind} · ${Math.round(entry.duration)} ms`;
      row.append(heading, url, meta); list.append(row);
    }
    if (network.length === 0) { const empty = el('p', 'dsh-bdt-empty'); empty.textContent = ui('No requests recorded', '暂无网络请求'); list.append(empty); }
    (list as HTMLElement).scrollTop = list.scrollHeight;
  };
  const renderElements = () => {
    const detail = root.querySelector('[data-dsh-element-detail]'); if (detail) detail.textContent = describe(selected);
  };
  const render = () => { renderConsole(); renderNetwork(); renderElements(); };
  const renderTabs = () => {
    Array.from(root.querySelectorAll('[data-dsh-tab]')).forEach((tab: any) => {
      const active = tab.dataset.dshTab === activeTab; tab.setAttribute('aria-selected', String(active));
    });
    Array.from(root.querySelectorAll('[data-dsh-pane]')).forEach((pane: any) => { pane.hidden = pane.dataset.dshPane !== activeTab; });
  };
  const setHighlight = (node: Element | null) => {
    highlighted = node;
    if (!node) { pickOverlay.hidden = true; return; }
    const box = node.getBoundingClientRect();
    Object.assign(pickOverlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    pickOverlay.hidden = false;
  };
  const stopPicking = () => { picking = false; setHighlight(null); root.querySelector('[data-dsh-pick]')?.classList.remove('dsh-bdt-active'); };
  const pickMove: EventListener = event => {
    if (!picking) return;
    const target = event.target as Element | null;
    if (!(target instanceof page.Element) || root.contains(target)) return;
    setHighlight(target);
  };
  const pickClick: EventListener = event => {
    if (!picking) return;
    const target = event.target as Element | null;
    if (!(target instanceof page.Element) || root.contains(target)) return;
    event.preventDefault(); event.stopPropagation();
    selected = target; stopPicking(); activeTab = 'elements'; renderElements(); renderTabs();
  };
  const keydown: EventListener = event => { if ((event as KeyboardEvent).key === 'Escape') stopPicking(); };
  document.addEventListener('pointermove', pickMove, true);
  document.addEventListener('click', pickClick, true);
  document.addEventListener('keydown', keydown, true);
  listeners.push(['pointermove', pickMove], ['click', pickClick], ['keydown', keydown]);

  const finishNetwork = (entry: any, status: string) => { entry.status = status; entry.duration = page.performance.now() - entry.time; addNetwork(entry); };
  if (typeof originalFetch === 'function') {
    page.fetch = function(input: unknown, init?: any) {
      const entry = { kind: 'fetch', method: String(init?.method ?? 'GET').toUpperCase(), url: urlOf(input), status: '', time: page.performance.now(), duration: 0 };
      return originalFetch.call(page, input, init).then((response: Response) => { finishNetwork(entry, `${response.status} ${response.statusText}`); return response; }, (error: unknown) => { finishNetwork(entry, 'failed'); throw error; });
    };
  }
  if (OriginalXHR && originalXHROpen && originalXHRSend) {
    OriginalXHR.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]) {
      xhrMeta.set(this, { method: method.toUpperCase(), url: urlOf(url) });
      return originalXHROpen.call(this, method, url, ...rest);
    };
    OriginalXHR.prototype.send = function(...args: unknown[]) {
      const meta = xhrMeta.get(this);
      if (meta) {
        const entry = { kind: 'xhr', method: meta.method, url: meta.url, status: '', time: page.performance.now(), duration: 0 };
        meta.entry = entry; this.addEventListener('loadend', () => finishNetwork(entry, `${this.status} ${this.statusText}`), { once: true });
      }
      return originalXHRSend.call(this, ...args);
    };
  }
  const PerformanceObserver = page.PerformanceObserver;
  const performanceObserver = PerformanceObserver ? new PerformanceObserver((list: PerformanceObserverEntryList) => {
    for (const resource of list.getEntries()) addNetwork({ kind: 'resource', method: 'GET', url: resource.name, status: '', time: resource.startTime, duration: resource.duration });
  }) : undefined;
  try { performanceObserver?.observe({ type: 'resource', buffered: true }); } catch { /* older Chromium */ }
  for (const resource of page.performance?.getEntriesByType('resource').slice(-50) ?? []) addNetwork({ kind: 'resource', method: 'GET', url: resource.name, status: '', time: resource.startTime, duration: resource.duration });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = page.console?.[level];
    if (typeof original !== 'function') continue;
    originalConsole[level] = original.bind(page.console);
    page.console[level] = (...args: unknown[]) => { recordLog(level, args); originalConsole[level](...args); };
  }
  const addListener = (name: string, listener: EventListener) => { pageWindow?.addEventListener(name, listener); listeners.push([name, listener]); };
  addListener('error', ((event: ErrorEvent) => recordLog('error', [event.error ?? event.message])) as EventListener);
  addListener('unhandledrejection', ((event: PromiseRejectionEvent) => recordLog('error', [event.reason])) as EventListener);

  style.textContent = `#dsh-browser-devtools{position:fixed;z-index:2147483647;top:0;right:0;width:min(390px,92vw);height:min(620px,100vh);display:flex;flex-direction:column;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;box-shadow:0 12px 40px #0008;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}#dsh-browser-devtools *{box-sizing:border-box}#dsh-browser-devtools button{color:inherit;background:#27272a;border:1px solid #52525b;border-radius:4px;padding:4px 8px;cursor:pointer}#dsh-browser-devtools button:hover{background:#3f3f46}#dsh-browser-devtools .dsh-bdt-head{display:flex;align-items:center;gap:6px;padding:7px 8px;background:#27272a;border-bottom:1px solid #3f3f46}#dsh-browser-devtools .dsh-bdt-title{font-weight:600;flex:1}#dsh-browser-devtools .dsh-bdt-tabs{display:flex;gap:3px;padding:6px 8px;border-bottom:1px solid #3f3f46}#dsh-browser-devtools .dsh-bdt-tabs button{flex:1;padding:4px;font-size:11px}#dsh-browser-devtools .dsh-bdt-tabs button[aria-selected=true]{background:#2563eb;border-color:#60a5fa}#dsh-browser-devtools .dsh-bdt-body{min-height:0;flex:1;overflow:auto;padding:8px}.dsh-bdt-list{min-height:100%;overflow:auto}.dsh-bdt-log,.dsh-bdt-network{padding:6px 4px;border-bottom:1px solid #3f3f46;overflow-wrap:anywhere}.dsh-bdt-log pre{white-space:pre-wrap;margin:3px 0}.dsh-bdt-log-warn{color:#facc15}.dsh-bdt-log-error{color:#f87171}.dsh-bdt-time{color:#a1a1aa;margin-right:8px;font-size:10px}.dsh-bdt-network{display:flex;flex-direction:column;gap:3px}.dsh-bdt-network span{color:#d4d4d8}.dsh-bdt-network small{color:#a1a1aa}.dsh-bdt-empty{color:#a1a1aa;text-align:center}.dsh-bdt-element{white-space:pre-wrap;overflow-wrap:anywhere}.dsh-bdt-active{background:#2563eb!important}.dsh-bdt-pick-overlay{position:fixed;pointer-events:none;border:2px solid #38bdf8;background:#38bdf833;z-index:2147483646}`;
  root.id = 'dsh-browser-devtools';
  root.innerHTML = '<header class="dsh-bdt-head"><span class="dsh-bdt-title">Page debugger</span><button type="button" data-dsh-close aria-label="Close">×</button></header><nav class="dsh-bdt-tabs" role="tablist"><button type="button" data-dsh-tab="elements" aria-selected="true">Elements</button><button type="button" data-dsh-tab="console" aria-selected="false">Console</button><button type="button" data-dsh-tab="network" aria-selected="false">Network</button></nav><main class="dsh-bdt-body"><section data-dsh-pane="elements"><button type="button" data-dsh-pick>Pick element</button><pre class="dsh-bdt-element" data-dsh-element-detail>No element selected</pre></section><section data-dsh-pane="console" hidden><button type="button" data-dsh-clear="console">Clear</button><div class="dsh-bdt-list" data-dsh-list="console"></div></section><section data-dsh-pane="network" hidden><button type="button" data-dsh-clear="network">Clear</button><div class="dsh-bdt-list" data-dsh-list="network"></div></section></main>';
  root.querySelector('[data-dsh-close]')?.addEventListener('click', () => page[key]?.close());
  Array.from(root.querySelectorAll('[data-dsh-tab]')).forEach((tab: any) => tab.addEventListener('click', () => { activeTab = tab.dataset.dshTab ?? 'elements'; renderTabs(); }));
  root.querySelector('[data-dsh-pick]')?.addEventListener('click', () => { picking = !picking; root.querySelector('[data-dsh-pick]')?.classList.toggle('dsh-bdt-active', picking); if (!picking) setHighlight(null); });
  Array.from(root.querySelectorAll('[data-dsh-clear]')).forEach((button: any) => button.addEventListener('click', () => { if (button.dataset.dshClear === 'console') logs.length = 0; else network.length = 0; render(); }));
  (document.head ?? document.documentElement).append(style); document.body.append(root); document.body.append(pickOverlay); pickOverlay.className = 'dsh-bdt-pick-overlay'; pickOverlay.hidden = true;
  const close = () => {
    if (closed) return;
    closed = true;
    stopPicking(); performanceObserver?.disconnect(); root.remove(); pickOverlay.remove(); style.remove();
    for (const [name, listener] of listeners) {
      if (name === 'pointermove' || name === 'click' || name === 'keydown') document.removeEventListener(name, listener, true);
      else pageWindow?.removeEventListener(name, listener);
    }
    for (const [level, original] of Object.entries(originalConsole)) page.console[level] = original;
    if (originalFetch) page.fetch = originalFetch;
    if (OriginalXHR && originalXHROpen && originalXHRSend) { OriginalXHR.prototype.open = originalXHROpen; OriginalXHR.prototype.send = originalXHRSend; }
    delete page[key];
  };
  const localize = () => {
    root.lang = locale;
    const labels: Array<[string, string]> = [
      ['.dsh-bdt-title', ui('Page debugger', '网页调试器')],
      ['[data-dsh-tab="elements"]', ui('Elements', '元素')],
      ['[data-dsh-tab="console"]', ui('Console', '控制台')],
      ['[data-dsh-tab="network"]', ui('Network', '网络')],
      ['[data-dsh-pick]', ui('Pick element', '选择元素')],
    ];
    for (const [selector, label] of labels) {
      const node = root.querySelector(selector); if (node) node.textContent = label;
    }
    root.querySelector('[data-dsh-close]')?.setAttribute('aria-label', ui('Close', '关闭'));
    root.querySelectorAll('[data-dsh-clear]').forEach((node: Element) => { node.textContent = ui('Clear', '清空'); });
    render();
  };
  page[key] = { opened: true, open: () => { root.hidden = false; page[key].opened = true; }, close,
    setLocale: (next: 'en' | 'zh') => { if (locale !== next) { locale = next; localize(); } },
  };
  localize();
  render(); renderTabs();
  return { opened: true, available: true };
}

export function guestScript(command: GuestCommand, language: 'en' | 'zh' = 'en'): string {
  return `(${guestController.toString()})(${JSON.stringify(command)},${JSON.stringify(language)})`;
}
