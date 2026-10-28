/** Global the page agent installs itself under, inside the inspected page. */
export const AGENT_KEY = '__DSH_BROWSER_DEVTOOLS__';
/** Bump when the agent's protocol changes, so a page keeps no stale agent. */
export const AGENT_VERSION = 2;

export interface LogEntry { seq: number; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; time: number }
export interface NetworkEntry {
  seq: number; url: string; method: string; type: string;
  /** HTTP status, or 0 when unknown (cross-origin resource timing) or failed. */
  status: number; failed: boolean;
  /** Bytes over the network; -1 when unknown, 0 with `cached`. */
  size: number; cached: boolean;
  start: number; duration: number;
}
export interface NodeSummary {
  id: number; type: number; name: string;
  attrs: Array<[string, string]>;
  /** Text and comment content, or an element's single short text child. */
  text?: string;
  /** Children shown in the tree (whitespace-only text is skipped). */
  childCount: number;
}
export interface Declaration { name: string; value: string; important: boolean }
export interface MatchedRule { selector: string; source: string; media?: string; declarations: Declaration[] }
export interface Box { margin: number[]; border: number[]; padding: number[]; width: number; height: number }
export interface Styles { inline: Declaration[]; rules: MatchedRule[]; blockedSheets: number; computed: Array<[string, string]>; box: Box }
export interface Preview { text: string; kind: string }
export interface Poll { logs: LogEntry[]; network: NetworkEntry[]; picking: boolean; picked?: { id: number; path: number[] } }

/**
 * Installs the page agent. Serialized and evaluated inside the Electron webview, so every
 * helper lives in this function: the page cannot reach this plugin's module realm.
 * The agent only collects data and answers the debugger panel; it draws nothing but the
 * element highlight, which lives in a closed shadow root so page styles cannot reach it.
 */
export function guestAgent(key: string, version: number): boolean {
  // `any` is intentional: this runs in the page's realm, where its own globals apply.
  const page = globalThis as any;
  if (page[key]?.version === version) return true;
  page[key]?.detach?.();
  const document = page.document;
  if (!document?.documentElement) return false;

  const logs: any[] = [], network: any[] = [];
  let logSeq = 0, netSeq = 0;
  const ids = new WeakMap<object, number>(), nodes = new Map<number, any>();
  let nextId = 1;
  let selected: any = null, picking = false, picked: { id: number; path: number[] } | undefined;
  const restore: Array<() => void> = [];

  const idOf = (node: any): number => {
    let id = ids.get(node);
    if (!id) { id = nextId++; ids.set(node, id); nodes.set(id, new page.WeakRef(node)); }
    return id;
  };
  const nodeOf = (id: number): any => id === 0 ? document : nodes.get(id)?.deref();

  // Chrome-like one-line previews of console arguments and evaluation results.
  const preview = (value: any, depth = 0): Preview => {
    const t = typeof value;
    if (value === null) return { text: 'null', kind: 'null' };
    if (t === 'undefined') return { text: 'undefined', kind: 'null' };
    if (t === 'string') return depth ? { text: JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value), kind: 'string' } : { text: value, kind: 'string' };
    if (t === 'number' || t === 'boolean') return { text: String(value), kind: 'number' };
    if (t === 'bigint') return { text: `${value}n`, kind: 'number' };
    if (t === 'symbol') return { text: String(value), kind: 'string' };
    if (t === 'function') return { text: `ƒ ${value.name || 'anonymous'}()`, kind: 'function' };
    try {
      if (value instanceof page.Error) return { text: depth ? `${value.name}: ${value.message}` : (value.stack || `${value.name}: ${value.message}`), kind: 'error' };
      if (value instanceof page.Element) {
        const cls = typeof value.className === 'string' && value.className.trim() ? `.${value.className.trim().split(/\s+/).join('.')}` : '';
        return { text: `${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ''}${cls}`, kind: 'node' };
      }
      if (value instanceof page.Node) return { text: value.nodeName, kind: 'node' };
      if (depth > 1) return { text: Array.isArray(value) ? `Array(${value.length})` : '{…}', kind: 'object' };
      if (Array.isArray(value)) {
        const items = value.slice(0, 20).map(item => preview(item, depth + 1).text);
        return { text: `(${value.length}) [${items.join(', ')}${value.length > 20 ? ', …' : ''}]`, kind: 'object' };
      }
      if (value instanceof page.Map) return { text: `Map(${value.size})`, kind: 'object' };
      if (value instanceof page.Set) return { text: `Set(${value.size})`, kind: 'object' };
      if (value instanceof page.Date) return { text: value.toString(), kind: 'object' };
      if (value instanceof page.RegExp) return { text: String(value), kind: 'string' };
      if (typeof value.then === 'function') return { text: 'Promise {<pending>}', kind: 'object' };
      const keys = Object.keys(value);
      const name = value.constructor && value.constructor !== page.Object ? `${value.constructor.name} ` : '';
      const fields = keys.slice(0, 12).map(k => `${k}: ${preview(value[k], depth + 1).text}`);
      return { text: `${name}{${fields.join(', ')}${keys.length > 12 ? ', …' : ''}}`, kind: 'object' };
    } catch { return { text: Object.prototype.toString.call(value), kind: 'object' }; }
  };
  /** `console.log` arguments with %s, %d, %i, %f, %o, %O and %c applied (styles are dropped). */
  const consoleText = (args: any[]): string => {
    const rest = [...args], parts: string[] = [];
    if (typeof rest[0] === 'string' && rest[0].includes('%')) {
      const format = rest.shift() as string;
      parts.push(format.replace(/%([sdifoOc%])/g, (match, spec) => {
        if (spec === '%') return '%';
        if (!rest.length) return match;
        const arg = rest.shift();
        if (spec === 'c') return '';
        if (spec === 'd' || spec === 'i') return String(parseInt(arg, 10));
        if (spec === 'f') return String(parseFloat(arg));
        return preview(arg, spec === 's' ? 0 : 1).text;
      }));
    }
    for (const arg of rest) parts.push(preview(arg).text);
    return parts.join(' ').slice(0, 20000);
  };
  const log = (level: string, text: string) => {
    logs.push({ seq: ++logSeq, level, text, time: Date.now() });
    if (logs.length > 1000) logs.shift();
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = page.console?.[level];
    if (typeof original !== 'function') continue;
    page.console[level] = function (this: unknown, ...args: any[]) { log(level, consoleText(args)); return original.apply(this, args); };
    restore.push(() => { page.console[level] = original; });
  }
  const onError = (event: any) => log('error', `Uncaught ${preview(event.error ?? event.message).text}`);
  const onRejection = (event: any) => log('error', `Uncaught (in promise) ${preview(event.reason).text}`);
  page.addEventListener('error', onError); page.addEventListener('unhandledrejection', onRejection);
  restore.push(() => { page.removeEventListener('error', onError); page.removeEventListener('unhandledrejection', onRejection); });

  const now = () => page.performance?.now?.() ?? Date.now();
  const absolute = (input: unknown): string => {
    try { return new page.URL(typeof input === 'string' ? input : String((input as any)?.url ?? input), page.location.href).href; } catch { return String(input); }
  };
  const request = (entry: Omit<NetworkEntry, 'seq'>) => {
    network.push({ ...entry, seq: ++netSeq });
    if (network.length > 1000) network.shift();
  };
  const originalFetch = page.fetch;
  if (typeof originalFetch === 'function') {
    page.fetch = function (input: unknown, init?: any) {
      const start = now(), method = String(init?.method ?? (input as any)?.method ?? 'GET').toUpperCase(), url = absolute(input);
      return originalFetch.call(page, input, init).then((response: any) => {
        const length = Number(response.headers?.get?.('content-length'));
        request({ url, method, type: 'fetch', status: response.status, failed: false, size: Number.isFinite(length) && length >= 0 ? length : -1, cached: false, start, duration: now() - start });
        return response;
      }, (error: unknown) => {
        request({ url, method, type: 'fetch', status: 0, failed: true, size: -1, cached: false, start, duration: now() - start });
        throw error;
      });
    };
    restore.push(() => { page.fetch = originalFetch; });
  }
  const XHR = page.XMLHttpRequest?.prototype, xhrOpen = XHR?.open, xhrSend = XHR?.send;
  if (xhrOpen && xhrSend) {
    const meta = new WeakMap<object, { method: string; url: string }>();
    XHR.open = function (this: any, method: string, url: unknown, ...rest: unknown[]) {
      meta.set(this, { method: String(method).toUpperCase(), url: absolute(url) });
      return xhrOpen.call(this, method, url, ...rest);
    };
    XHR.send = function (this: any, ...args: unknown[]) {
      const info = meta.get(this), start = now();
      if (info) this.addEventListener('loadend', () => {
        const length = Number(this.getResponseHeader?.('content-length'));
        request({ ...info, type: 'xhr', status: this.status, failed: this.status === 0, size: Number.isFinite(length) && this.getResponseHeader?.('content-length') !== null ? length : -1, cached: false, start, duration: now() - start });
      }, { once: true });
      return xhrSend.apply(this, args);
    };
    restore.push(() => { XHR.open = xhrOpen; XHR.send = xhrSend; });
  }
  const resource = (timing: any) => request({
    url: timing.name, method: 'GET', type: timing.initiatorType || 'other', status: timing.responseStatus ?? 0, failed: false,
    size: timing.transferSize > 0 ? timing.transferSize : timing.decodedBodySize > 0 ? 0 : -1, cached: timing.transferSize === 0 && timing.decodedBodySize > 0,
    start: timing.startTime, duration: timing.duration,
  });
  // Requests made before the panel opened are only known from resource timing.
  for (const timing of page.performance?.getEntriesByType?.('resource') ?? []) resource(timing);
  if (page.PerformanceObserver) {
    const observer = new page.PerformanceObserver((list: any) => {
      // Fetch and XHR are recorded with their method and status by the wrappers above.
      for (const timing of list.getEntries()) if (timing.initiatorType !== 'fetch' && timing.initiatorType !== 'xmlhttprequest') resource(timing);
    });
    try { observer.observe({ type: 'resource' }); restore.push(() => observer.disconnect()); } catch { /* No resource timing. */ }
  }

  // Element highlight in Chrome's box-model colours, isolated from page CSS.
  const overlayHost = document.createElement('dsh-browser-devtools-overlay');
  const shadow = overlayHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = '<style>:host{all:initial}div{position:fixed;box-sizing:border-box}.m{border-style:solid;border-color:rgba(246,178,107,.66)}.b{border-style:solid;border-color:rgba(255,229,153,.66)}.p{border-style:solid;border-color:rgba(147,196,125,.55)}.c{background:rgba(111,168,220,.66)}.t{font:11px/1.4 system-ui,sans-serif;background:#fff;color:#333;padding:3px 6px;border-radius:3px;box-shadow:0 1px 4px #0005;white-space:nowrap}.t b{color:#881280;font-weight:normal}.t i{color:#1a1aa6;font-style:normal}.t span{color:#888;margin-left:8px}</style><div class="m"></div><div class="b"></div><div class="p"></div><div class="c"></div><div class="t"></div>';
  overlayHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:none';
  const show = (on: boolean) => { overlayHost.style.display = on ? 'block' : 'none'; };
  const [marginBox, borderBox, paddingBox, contentBox, tip] = Array.from(shadow.querySelectorAll('div')) as any[];
  const px = (value: string) => parseFloat(value) || 0;
  const highlight = (node: any) => {
    if (!node || node.nodeType !== 1 || !node.isConnected) { show(false); return; }
    if (!overlayHost.isConnected) document.documentElement.append(overlayHost);
    const rect = node.getBoundingClientRect(), style = page.getComputedStyle(node);
    const sides = (prefix: string, suffix = '') => ['top', 'right', 'bottom', 'left'].map(side => px(style.getPropertyValue(`${prefix}-${side}${suffix}`)));
    const [mt, mr, mb, ml] = sides('margin'), [bt, br, bb, bl] = sides('border', '-width'), [pt, pr, pb, pl] = sides('padding');
    const place = (box: any, left: number, top: number, width: number, height: number, widths?: number[]) => {
      Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` });
      if (widths) box.style.borderWidth = widths.map(w => `${Math.max(0, w)}px`).join(' ');
    };
    place(marginBox, rect.left - ml, rect.top - mt, rect.width + ml + mr, rect.height + mt + mb, [mt, mr, mb, ml]);
    place(borderBox, rect.left, rect.top, rect.width, rect.height, [bt, br, bb, bl]);
    place(paddingBox, rect.left + bl, rect.top + bt, rect.width - bl - br, rect.height - bt - bb, [pt, pr, pb, pl]);
    place(contentBox, rect.left + bl + pl, rect.top + bt + pt, rect.width - bl - br - pl - pr, rect.height - bt - bb - pt - pb);
    const cls = typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    tip.textContent = '';
    const name = document.createElement('b'); name.textContent = node.tagName.toLowerCase();
    const extra = document.createElement('i'); extra.textContent = `${node.id ? `#${node.id}` : ''}${cls}`;
    const size = document.createElement('span'); size.textContent = `${Math.round(rect.width * 100) / 100} × ${Math.round(rect.height * 100) / 100}`;
    tip.append(name, extra, size);
    const below = rect.bottom + mb + 30 < page.innerHeight || rect.top - mt < 30;
    Object.assign(tip.style, { left: `${Math.max(2, Math.min(rect.left, page.innerWidth - 260))}px`, top: `${below ? Math.min(rect.bottom + mb + 6, page.innerHeight - 26) : rect.top - mt - 28}px` });
    show(true);
  };
  restore.push(() => overlayHost.remove());

  const pathOf = (node: any): number[] => {
    const path: number[] = [];
    for (let current = node; current && current !== document; current = current.parentNode) path.unshift(idOf(current));
    return path;
  };
  const target = (event: any) => event.composedPath?.()[0] ?? event.target;
  const pickMove = (event: any) => { if (picking) { const node = target(event); if (node?.nodeType === 1 && node !== overlayHost) highlight(node); } };
  const pickClick = (event: any) => {
    if (!picking) return;
    const node = target(event);
    if (node?.nodeType !== 1 || node === overlayHost) return;
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    picking = false; selected = node; highlight(null);
    picked = { id: idOf(node), path: pathOf(node) };
  };
  // Swallow the press that ends a pick, so the page does not also react to it.
  const pickBlock = (event: any) => { if (picking) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); } };
  const pickKey = (event: any) => { if (picking && event.key === 'Escape') { picking = false; highlight(null); } };
  const capture = [['pointermove', pickMove], ['click', pickClick], ['pointerdown', pickBlock], ['mousedown', pickBlock], ['pointerup', pickBlock], ['mouseup', pickBlock], ['keydown', pickKey]] as const;
  for (const [name, listener] of capture) page.addEventListener(name, listener, true);
  restore.push(() => { for (const [name, listener] of capture) page.removeEventListener(name, listener, true); });

  const summary = (node: any): NodeSummary => {
    const id = idOf(node), type = node.nodeType;
    if (type === 3 || type === 8) return { id, type, name: node.nodeName, attrs: [], text: String(node.nodeValue).trim().slice(0, 500), childCount: 0 };
    if (type === 10) return { id, type, name: node.name || 'html', attrs: [], childCount: 0 };
    const children = shown(node);
    const only = children.length === 1 && children[0].nodeType === 3 ? String(children[0].nodeValue).trim() : undefined;
    const inline = only !== undefined && only.length <= 80 && !only.includes('\n');
    return {
      id, type, name: String(node.localName ?? node.nodeName).toLowerCase(),
      attrs: Array.from(node.attributes ?? []).slice(0, 50).map((a: any) => [a.name, a.value.length > 300 ? `${a.value.slice(0, 300)}…` : a.value] as [string, string]),
      ...(inline ? { text: only } : {}), childCount: inline ? 0 : children.length,
    };
  };
  const shown = (node: any): any[] => {
    const list = node.nodeType === 1 && node.shadowRoot ? [...Array.from(node.shadowRoot.childNodes), ...Array.from(node.childNodes)] : Array.from(node.childNodes ?? []);
    return list.filter((child: any) => child !== overlayHost && (child.nodeType !== 3 || String(child.nodeValue).trim()) && [1, 3, 8, 10].includes(child.nodeType));
  };

  const declarations = (style: any): Declaration[] => {
    const list: Declaration[] = [];
    for (let i = 0; i < style.length; i++) {
      const name = style[i];
      list.push({ name, value: style.getPropertyValue(name), important: style.getPropertyPriority(name) === 'important' });
    }
    return list;
  };
  const styles = (node: any): Styles | null => {
    if (node?.nodeType !== 1) return null;
    const rules: MatchedRule[] = [];
    let blockedSheets = 0;
    const walk = (list: any, source: string, media?: string) => {
      for (const rule of Array.from(list) as any[]) {
        if (rules.length >= 300) return;
        if (rule.selectorText !== undefined && rule.style) {
          let matches = false;
          try { matches = node.matches(rule.selectorText); } catch { /* Selector this engine cannot match. */ }
          if (matches) rules.push({ selector: rule.selectorText, source, ...(media ? { media } : {}), declarations: declarations(rule.style) });
        } else if (rule.cssRules) {
          const condition = rule.media?.mediaText ?? rule.conditionText;
          if (rule.media && condition && typeof page.matchMedia === 'function' && !page.matchMedia(condition).matches) continue;
          walk(rule.cssRules, source, condition ? `${rule.media ? '@media' : '@supports'} ${condition}` : media);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets) as any[]) {
      if (sheet.disabled) continue;
      const source = sheet.href ? (String(sheet.href).split(/[?#]/)[0].split('/').pop() || sheet.href) : '<style>';
      let list;
      try { list = sheet.cssRules; } catch { blockedSheets++; continue; }
      if (list) walk(list, source);
    }
    const computed = page.getComputedStyle(node), all: Array<[string, string]> = [];
    for (let i = 0; i < computed.length; i++) all.push([computed[i], computed.getPropertyValue(computed[i])]);
    all.sort((a, b) => a[0].localeCompare(b[0]));
    const four = (prefix: string, suffix = '') => ['top', 'right', 'bottom', 'left'].map(side => px(computed.getPropertyValue(`${prefix}-${side}${suffix}`)));
    const rect = node.getBoundingClientRect(), border = four('border', '-width'), padding = four('padding');
    return {
      inline: declarations(node.style ?? { length: 0 }), rules: rules.reverse(), blockedSheets, computed: all,
      box: { margin: four('margin'), border, padding, width: rect.width - border[1] - border[3] - padding[1] - padding[3], height: rect.height - border[0] - border[2] - padding[0] - padding[2] },
    };
  };

  page[key] = {
    version,
    selected: () => selected,
    preview: (value: unknown) => preview(value),
    detach() { for (const undo of restore.splice(0).reverse()) { try { undo(); } catch { /* Page replaced it. */ } } if (page[key]?.version === version) delete page[key]; },
    run(command: string, arg: any): unknown {
      if (command === 'poll') {
        const result: Poll = { logs: logs.filter(e => e.seq > (arg?.log ?? 0)), network: network.filter(e => e.seq > (arg?.network ?? 0)), picking, ...(picked ? { picked } : {}) };
        picked = undefined;
        return result;
      }
      if (command === 'node') { const node = nodeOf(arg?.id ?? 0); return node ? shown(node).map(summary) : null; }
      if (command === 'styles') return styles(nodeOf(arg?.id));
      if (command === 'highlight') { highlight(arg?.id ? nodeOf(arg.id) : null); return true; }
      if (command === 'select') { selected = arg?.id ? nodeOf(arg.id) ?? null : null; return true; }
      if (command === 'pick') { picking = Boolean(arg?.on); if (!picking) highlight(null); return picking; }
      if (command === 'clear') { if (arg === 'console') logs.length = 0; else network.length = 0; return true; }
      return null;
    },
  };
  return true;
}

/**
 * The full agent, installed on first use and after each navigation. Bundlers that keep function
 * names wrap them in a `__name` helper the page does not have, so a no-op one is supplied.
 */
export const agentScript = () => `(()=>{const __name=f=>f;return(${guestAgent.toString()})(${JSON.stringify(AGENT_KEY)},${AGENT_VERSION})})()`;
/** A short command for an installed agent; `null` means the page has no current agent. */
export const commandScript = (command: string, arg?: unknown) =>
  `(()=>{const a=window[${JSON.stringify(AGENT_KEY)}];return a&&a.version===${AGENT_VERSION}?a.run(${JSON.stringify(command)},${JSON.stringify(arg ?? null)}):null})()`;
/** Removes the agent and restores what it wrapped. */
export const detachScript = () => `(()=>{const a=window[${JSON.stringify(AGENT_KEY)}];if(a&&a.detach)a.detach();return true})()`;
/**
 * Evaluates console input in the page as an expression, with `$0` bound to the selected element.
 * Compiling it as part of the injected script (not `eval`) keeps it working under a strict CSP.
 */
export const evaluateScript = (expression: string) =>
  `(async()=>{const __dshAgent=window[${JSON.stringify(AGENT_KEY)}];const $0=__dshAgent&&__dshAgent.selected?__dshAgent.selected():undefined;const __dshPreview=v=>__dshAgent&&__dshAgent.preview?__dshAgent.preview(v):{text:String(v),kind:typeof v};try{return{result:__dshPreview(await (\n${expression}\n))}}catch(__dshError){return{error:__dshPreview(__dshError)}}})()`;
