/** Global the page agent installs itself under, inside the inspected page. */
export const AGENT_KEY = '__DSH_BROWSER_DEVTOOLS__';
/** Bump when the agent's protocol changes, so a page keeps no stale agent. */
export const AGENT_VERSION = 3;

export interface LogEntry { seq: number; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string; time: number }
export interface NetworkEntry {
  seq: number; url: string; method: string; type: string;
  /** HTTP status, or 0 when unknown (cross-origin resource timing) or failed. */
  status: number; failed: boolean;
  /** Bytes over the network; -1 when unknown, 0 with `cached`. */
  size: number; cached: boolean;
  start: number; duration: number;
}
/** Resource timing marks for one request, in milliseconds since the page's time origin. */
export interface Timing {
  startTime: number; redirectStart: number; redirectEnd: number; fetchStart: number;
  domainLookupStart: number; domainLookupEnd: number; connectStart: number; connectEnd: number; secureConnectionStart: number;
  requestStart: number; responseStart: number; responseEnd: number; duration: number;
}
/** What the page passed as a request body. Form fields hold `null` for files. */
export type Payload = { kind: 'text'; text: string; truncated: boolean } | { kind: 'form'; fields: Array<[string, string | null]> } | { kind: 'binary'; size: number } | { kind: 'stream' };
/**
 * One request in full, read when it is selected in the Network panel. Headers and bodies are only
 * known for Fetch and XHR the page started while the agent was installed.
 */
export interface RequestDetail {
  statusText: string;
  /** The final URL after redirects, when it differs from the requested one. */
  responseUrl?: string;
  requestHeaders?: Array<[string, string]>;
  responseHeaders?: Array<[string, string]>;
  payload?: Payload;
  /** A text-like response body; `done` is false while it is still arriving. */
  body?: { text: string; truncated: boolean; done: boolean };
  /** Why there is no body: not text, no body at all, dropped to save memory, or not recorded. */
  bodyNote?: 'binary' | 'empty' | 'dropped' | 'unrecorded';
  error?: string;
  timing?: Timing;
  /** The body or timing is still arriving; ask again. */
  pending: boolean;
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
  // Full request records, kept apart from the polled list and bounded in total size.
  const BODY_CAP = 512 * 1024, PAYLOAD_CAP = 64 * 1024, BUDGET = 8 * 1024 * 1024;
  const details = new Map<number, any>(), awaiting: any[] = [];
  let stored = 0, recording = true;
  const safe = <T>(work: () => T): T | undefined => { try { return work(); } catch { return undefined; } };
  const account = (detail: any) => {
    if (!details.has(detail.seq)) return;
    const size = (detail.body?.text.length ?? 0) + (detail.payload?.text?.length ?? 0);
    stored += size - (detail.counted ?? 0); detail.counted = size;
    for (const old of details.values()) {
      if (stored <= BUDGET) break;
      if (old === detail || !old.counted) continue;
      stored -= old.counted; old.counted = 0; old.dropped = true;
      if (old.body) { old.body = undefined; old.bodyNote = 'dropped'; }
      if (old.payload?.kind === 'text') old.payload = { kind: 'text', text: '', truncated: true };
    }
  };
  const forget = (seq: number) => {
    const detail = details.get(seq);
    if (!detail) return;
    stored -= detail.counted ?? 0; detail.dropped = true; details.delete(seq);
  };
  const request = (entry: Omit<NetworkEntry, 'seq'>, detail?: any) => {
    const seq = ++netSeq;
    network.push({ ...entry, seq });
    if (detail) { detail.seq = seq; details.set(seq, detail); account(detail); }
    if (network.length > 1000) forget(network.shift().seq);
  };
  const headerList = (source: any): Array<[string, string]> => {
    const list: Array<[string, string]> = [];
    try {
      if (!source) return list;
      if (typeof source.forEach === 'function' && !Array.isArray(source)) source.forEach((value: unknown, name: unknown) => { list.push([String(name), String(value)]); });
      else for (const [name, value] of Array.isArray(source) ? source : Object.entries(source)) list.push([String(name), String(value)]);
    } catch { /* Malformed headers; the request rejects them too. */ }
    return list.slice(0, 200).map(([name, value]) => [name.toLowerCase().slice(0, 1024), value.slice(0, 8192)]);
  };
  const rawHeaders = (text: string): Array<[string, string]> => headerList(String(text || '').split(/\r?\n/).filter(line => line.includes(':'))
    .map(line => { const at = line.indexOf(':'); return [line.slice(0, at), line.slice(at + 1).trim()]; }));
  const payloadOf = (body: any): any => {
    if (body === undefined || body === null) return undefined;
    try {
      if (typeof body === 'string') return { kind: 'text', text: body.slice(0, PAYLOAD_CAP), truncated: body.length > PAYLOAD_CAP };
      if (page.URLSearchParams && body instanceof page.URLSearchParams) return payloadOf(body.toString());
      if (page.FormData && body instanceof page.FormData) {
        const fields: Array<[string, string | null]> = [];
        body.forEach((value: unknown, name: string) => { if (fields.length < 500) fields.push([name, typeof value === 'string' ? value.slice(0, 8192) : null]); });
        return { kind: 'form', fields };
      }
      if (page.Blob && body instanceof page.Blob) return { kind: 'binary', size: body.size };
      if (body instanceof page.ArrayBuffer || page.ArrayBuffer?.isView?.(body)) return { kind: 'binary', size: body.byteLength };
      if (page.ReadableStream && body instanceof page.ReadableStream) return { kind: 'stream' };
      if (page.Document && body instanceof page.Document) return payloadOf(new page.XMLSerializer().serializeToString(body));
    } catch { /* An exotic body; describe it as text. */ }
    return payloadOf(String(body));
  };
  // The Content-Type the browser adds for a body the page did not label.
  const implicitType = (body: any): string | undefined => safe(() => typeof body === 'string' ? 'text/plain;charset=UTF-8'
    : page.URLSearchParams && body instanceof page.URLSearchParams ? 'application/x-www-form-urlencoded;charset=UTF-8'
    : page.FormData && body instanceof page.FormData ? 'multipart/form-data'
    : page.Blob && body instanceof page.Blob && body.type ? body.type : undefined);
  const withBody = (detail: any, body: any) => {
    detail.payload = payloadOf(body);
    const type = implicitType(body);
    if (type && !detail.requestHeaders.some(([name]: [string]) => name === 'content-type')) detail.requestHeaders.push(['content-type', type]);
  };
  const headerOf = (list: Array<[string, string]> | undefined, name: string) => list?.find(([key]) => key === name)?.[1] ?? '';
  const textLike = (mime: string) => !mime || /^text\/|[/+](json|x-ndjson|ndjson|xml|javascript|ecmascript|x-www-form-urlencoded)\b/i.test(mime);
  /** Reads a cloned body as text up to `cap`, reporting progress; `update` returns false to stop. */
  const readText = async (source: any, mime: string, cap: number, update: (text: string, truncated: boolean, done: boolean) => boolean) => {
    let decoder: any;
    try { decoder = new page.TextDecoder(/charset=["']?([\w-]+)/i.exec(mime)?.[1] ?? 'utf-8'); } catch { decoder = safe(() => new page.TextDecoder()); }
    // Taking a reader locks the body, so only take one that will be used.
    const reader = decoder ? source.body?.getReader?.() : undefined;
    if (!reader) { const text = String(await source.text()); update(text.slice(0, cap), text.length > cap, true); return; }
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { text += decoder.decode(); break; }
      text += decoder.decode(value, { stream: true });
      if (text.length >= cap || !update(text, false, false)) { void reader.cancel().catch(() => {}); update(text.slice(0, cap), text.length >= cap, true); return; }
    }
    update(text, false, true);
  };
  const setBody = (detail: any, text: string, truncated: boolean, done: boolean): boolean => {
    if (detail.dropped || !recording) return false;
    detail.body = { text, truncated, done };
    account(detail);
    return true;
  };
  // Fetch and XHR resource timing arrives after the response; match it to the request it measures.
  const expect = (detail: any) => { awaiting.push(detail); if (awaiting.length > 300) awaiting.shift(); };
  const claim = (timing: any) => {
    const url = String(timing.name).split('#')[0];
    let best = -1, gap = 1000;
    awaiting.forEach((detail, index) => {
      const distance = Math.abs(timing.startTime - detail.start);
      if (detail.url.split('#')[0] === url && distance < gap) { best = index; gap = distance; }
    });
    if (best >= 0) awaiting.splice(best, 1)[0].timing = timing;
  };
  const originalFetch = page.fetch;
  if (typeof originalFetch === 'function') {
    page.fetch = function (input: unknown, init?: any) {
      const start = now(), method = String(init?.method ?? (input as any)?.method ?? 'GET').toUpperCase(), url = absolute(input);
      const detail: any = { url, start, statusText: '', requestHeaders: [], timed: true };
      safe(() => {
        const isRequest = page.Request && input instanceof page.Request;
        const headers = init?.headers ?? (isRequest ? (input as any).headers : undefined);
        detail.requestHeaders = headerList(safe(() => new page.Headers(headers)) ?? headers);
        if (init?.body !== undefined && init.body !== null) withBody(detail, init.body);
        else if (isRequest && (input as any).body && !(input as any).bodyUsed) {
          // Read a copy before fetch consumes the original.
          const copy = (input as any).clone();
          detail.payload = { kind: 'text', text: '', truncated: false };
          void readText(copy, headerOf(detail.requestHeaders, 'content-type'), PAYLOAD_CAP, (text, truncated) => {
            if (detail.dropped || !recording) return false;
            detail.payload = { kind: 'text', text, truncated }; account(detail); return true;
          }).catch(() => {});
        }
      });
      expect(detail);
      return originalFetch.call(page, input, init).then((response: any) => {
        const length = Number(response.headers?.get?.('content-length'));
        safe(() => {
          detail.statusText = String(response.statusText ?? '');
          detail.responseHeaders = headerList(response.headers);
          if (response.url && response.url !== url) detail.responseUrl = String(response.url);
          const mime = headerOf(detail.responseHeaders, 'content-type');
          if (method === 'HEAD' || [101, 204, 205, 304].includes(response.status) || response.type === 'opaque' || response.body === null) detail.bodyNote = 'empty';
          else if (!textLike(mime)) detail.bodyNote = 'binary';
          else {
            // A clone is read alongside the page; cancelling it leaves the page's copy intact.
            detail.body = { text: '', truncated: false, done: false };
            void readText(response.clone(), mime, BODY_CAP, (text, truncated, done) => setBody(detail, text, truncated, done)).catch((error: any) => {
              if (detail.body) detail.body.done = true;
              detail.error = String(error?.message ?? error);
            });
          }
        });
        request({ url, method, type: 'fetch', status: response.status, failed: false, size: Number.isFinite(length) && length >= 0 ? length : -1, cached: false, start, duration: now() - start }, detail);
        return response;
      }, (error: unknown) => {
        detail.error = String((error as any)?.message ?? error); detail.bodyNote = 'empty';
        request({ url, method, type: 'fetch', status: 0, failed: true, size: -1, cached: false, start, duration: now() - start }, detail);
        throw error;
      });
    };
    restore.push(() => { page.fetch = originalFetch; });
  }
  const XHR = page.XMLHttpRequest?.prototype, xhrOpen = XHR?.open, xhrSend = XHR?.send, xhrHeader = XHR?.setRequestHeader;
  if (xhrOpen && xhrSend && xhrHeader) {
    const meta = new WeakMap<object, { method: string; url: string; headers: Array<[string, string]> }>();
    XHR.open = function (this: any, method: string, url: unknown, ...rest: unknown[]) {
      meta.set(this, { method: String(method).toUpperCase(), url: absolute(url), headers: [] });
      return xhrOpen.call(this, method, url, ...rest);
    };
    XHR.setRequestHeader = function (this: any, name: string, value: string) {
      const result = xhrHeader.call(this, name, value);
      meta.get(this)?.headers.push([String(name).toLowerCase(), String(value)]);
      return result;
    };
    XHR.send = function (this: any, ...args: unknown[]) {
      const info = meta.get(this), start = now();
      if (info) {
        const detail: any = { url: info.url, start, statusText: '', requestHeaders: info.headers.slice(0, 200), timed: true };
        if (info.method !== 'GET' && info.method !== 'HEAD') safe(() => withBody(detail, args[0]));
        expect(detail);
        this.addEventListener('loadend', () => {
          const length = Number(this.getResponseHeader?.('content-length'));
          safe(() => {
            detail.statusText = String(this.statusText ?? '');
            detail.responseHeaders = rawHeaders(this.getAllResponseHeaders?.());
            if (this.responseURL && this.responseURL !== info.url) detail.responseUrl = String(this.responseURL);
            const type = this.responseType, mime = headerOf(detail.responseHeaders, 'content-type');
            const text = this.status === 0 ? undefined
              : type === 'json' ? (this.response === null ? undefined : JSON.stringify(this.response))
              : type === 'document' ? this.responseXML?.documentElement?.outerHTML
              : (type === '' || type === 'text') && textLike(mime) ? this.responseText : undefined;
            if (this.status === 0) { detail.error = 'Request failed'; detail.bodyNote = 'empty'; }
            else if (text === undefined) detail.bodyNote = type === 'json' ? 'empty' : 'binary';
            else if (text === '') detail.bodyNote = 'empty';
            else detail.body = { text: text.slice(0, BODY_CAP), truncated: text.length > BODY_CAP, done: true };
          });
          request({ url: info.url, method: info.method, type: 'xhr', status: this.status, failed: this.status === 0, size: Number.isFinite(length) && this.getResponseHeader?.('content-length') !== null ? length : -1, cached: false, start, duration: now() - start }, detail);
        }, { once: true });
      }
      return xhrSend.apply(this, args);
    };
    restore.push(() => { XHR.open = xhrOpen; XHR.send = xhrSend; XHR.setRequestHeader = xhrHeader; });
  }
  // Requests still in flight at detach stop reading their bodies.
  restore.push(() => { recording = false; });
  const resource = (timing: any) => request({
    url: timing.name, method: 'GET', type: timing.initiatorType || 'other', status: timing.responseStatus ?? 0, failed: false,
    size: timing.transferSize > 0 ? timing.transferSize : timing.decodedBodySize > 0 ? 0 : -1, cached: timing.transferSize === 0 && timing.decodedBodySize > 0,
    start: timing.startTime, duration: timing.duration,
  }, { url: timing.name, start: timing.startTime, statusText: '', bodyNote: 'unrecorded', timing });
  // The document itself, then requests made before the panel opened, are only known from resource timing.
  for (const timing of page.performance?.getEntriesByType?.('navigation') ?? []) resource(timing);
  for (const timing of page.performance?.getEntriesByType?.('resource') ?? []) resource(timing);
  if (page.PerformanceObserver) {
    const observer = new page.PerformanceObserver((list: any) => {
      // Fetch and XHR are recorded with their method and status by the wrappers above.
      for (const timing of list.getEntries()) {
        if (timing.initiatorType === 'fetch' || timing.initiatorType === 'xmlhttprequest') claim(timing); else resource(timing);
      }
    });
    try { observer.observe({ type: 'resource' }); restore.push(() => observer.disconnect()); } catch { /* No resource timing. */ }
  }
  const TIMING_KEYS = ['startTime', 'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd',
    'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd', 'duration'];
  const describe = (seq: number): RequestDetail | null => {
    const detail = details.get(seq);
    if (!detail) return null;
    const result: RequestDetail = {
      statusText: detail.statusText,
      ...(detail.responseUrl ? { responseUrl: detail.responseUrl } : {}),
      ...(detail.timed ? { requestHeaders: detail.requestHeaders } : {}),
      ...(detail.responseHeaders ? { responseHeaders: detail.responseHeaders } : {}),
      ...(detail.payload ? { payload: detail.payload } : {}),
      ...(detail.body ? { body: { ...detail.body } } : {}),
      ...(detail.bodyNote ? { bodyNote: detail.bodyNote } : {}),
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.timing ? { timing: Object.fromEntries(TIMING_KEYS.map(key => [key, Number(detail.timing[key]) || 0])) as unknown as Timing } : {}),
      pending: Boolean(detail.body && !detail.body.done) || Boolean(detail.timed && !detail.timing && !detail.error && now() - detail.start < 10_000),
    };
    // Stay inside the owner's 1 MB reply limit.
    const size = () => { const json = JSON.stringify(result); return page.TextEncoder ? new page.TextEncoder().encode(json).length : json.length * 3; };
    for (let i = 0; i < 12 && size() > 900_000; i++) {
      if (result.body?.text) result.body = { ...result.body, text: result.body.text.slice(0, result.body.text.length >> 1), truncated: true };
      else if (result.payload?.kind === 'text' && result.payload.text) result.payload = { ...result.payload, text: result.payload.text.slice(0, result.payload.text.length >> 1), truncated: true };
      else break;
    }
    return result;
  };

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
      if (command === 'request') return describe(Number(arg?.seq));
      if (command === 'clear') {
        if (arg === 'console') logs.length = 0;
        else { network.length = 0; for (const seq of Array.from(details.keys())) forget(seq); awaiting.length = 0; }
        return true;
      }
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
