import { agentScript, commandScript, detachScript, evaluateScript, type LogEntry, type NetworkEntry, type NodeSummary, type Poll, type Preview, type Styles } from './guest.js';
import { ui } from './i18n.js';

/** The part of Electron's webview tag the panel uses. */
export interface PanelView extends HTMLElement {
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}
type Tab = 'elements' | 'console' | 'network';
type Filter = 'styles' | 'computed' | 'console' | 'network';
type Row = { kind: 'log'; entry: LogEntry; count: number } | { kind: 'input'; text: string } | { kind: 'result'; preview: Preview; error: boolean };
interface TreeNode { node: NodeSummary; children?: number[]; expanded: boolean }

const HEIGHT_KEY = 'dsh-browser-devtools:height';
const POLL_MS = 500;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const LEVELS = [['all', 'All levels'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['debug', 'Verbose']] as const;
const TYPES = [['all', 'All'], ['fetch', 'Fetch/XHR'], ['doc', 'Doc'], ['css', 'CSS'], ['js', 'JS'], ['font', 'Font'], ['img', 'Img'], ['media', 'Media'], ['other', 'Other']] as const;
// Fixed icon markup, never page content.
const ICONS = {
  inspect: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 13.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h9.5a1 1 0 0 1 1 1v3.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m8 8 6.5 2.4-2.8 1.1-1.1 2.8z" fill="currentColor"/></svg>',
  clear: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="m4 12 8-8" stroke="currentColor" stroke-width="1.3"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 1.5 13.5h13z" fill="currentColor"/><path d="M8 6.5v3.3M8 11.3v.2" stroke="var(--bdt-bg)" stroke-width="1.4" stroke-linecap="round"/></svg>',
  error: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="m5.7 5.7 4.6 4.6m0-4.6-4.6 4.6" stroke="var(--bdt-bg)" stroke-width="1.4" stroke-linecap="round"/></svg>',
};

const css = `
.dsh-bdt-panel{--bdt-bg:#fff;--bdt-bar:#f1f3f4;--bdt-line:#cacdd1;--bdt-soft:#e8eaed;--bdt-text:#202124;--bdt-muted:#5f6368;--bdt-accent:#1a73e8;--bdt-hover:#eef3fd;--bdt-select:#cfe8fc;--bdt-select-blur:#e8eaed;--bdt-tag:#881280;--bdt-attr:#994500;--bdt-value:#1a1aa6;--bdt-comment:#236e25;--bdt-string:#c41a16;--bdt-number:#1a1aa6;--bdt-warn-bg:#fffbe5;--bdt-warn-line:#fff5c2;--bdt-warn:#5c3c00;--bdt-warn-icon:#e37400;--bdt-error-bg:#fff0f0;--bdt-error-line:#ffd6d6;--bdt-error:#d93025;
  position:relative;display:flex;flex-direction:column;flex:0 0 auto;min-height:120px;color:var(--bdt-text);background:var(--bdt-bg);border-top:1px solid var(--bdt-line);font:12px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;container-type:inline-size;-webkit-app-region:no-drag}
body[data-ds-dark-theme] .dsh-bdt-panel{--bdt-bg:#202124;--bdt-bar:#292a2d;--bdt-line:#3c4043;--bdt-soft:#35363a;--bdt-text:#e8eaed;--bdt-muted:#9aa0a6;--bdt-accent:#8ab4f8;--bdt-hover:#2c3440;--bdt-select:#004a77;--bdt-select-blur:#3c4043;--bdt-tag:#5db0d7;--bdt-attr:#9bbbdc;--bdt-value:#f29766;--bdt-comment:#898989;--bdt-string:#f28b54;--bdt-number:#9980ff;--bdt-warn-bg:#332b00;--bdt-warn-line:#665500;--bdt-warn:#fdd663;--bdt-warn-icon:#fdd663;--bdt-error-bg:#290000;--bdt-error-line:#5c0000;--bdt-error:#f28b82}
.dsh-bdt-panel *{box-sizing:border-box}
.dsh-bdt-panel button,.dsh-bdt-panel input,.dsh-bdt-panel select,.dsh-bdt-panel textarea{font:inherit;color:inherit}
.dsh-bdt-resize{position:absolute;top:-4px;left:0;right:0;height:7px;cursor:ns-resize;z-index:1}
.dsh-bdt-bar{display:flex;align-items:stretch;height:27px;flex:none;background:var(--bdt-bar);border-bottom:1px solid var(--bdt-line);overflow:hidden}
.dsh-bdt-icon{display:inline-flex;align-items:center;justify-content:center;width:27px;flex:none;padding:0;border:0;background:transparent;color:var(--bdt-muted);cursor:pointer}
.dsh-bdt-icon svg{width:16px;height:16px}
.dsh-bdt-icon:hover{color:var(--bdt-text);background:var(--bdt-soft)}
.dsh-bdt-icon[aria-pressed=true]{color:var(--bdt-accent)}
.dsh-bdt-icon:focus-visible,.dsh-bdt-tab:focus-visible,.dsh-bdt-tree:focus-visible{outline:2px solid var(--bdt-accent);outline-offset:-2px}
.dsh-bdt-sep{width:1px;margin:6px 4px;background:var(--bdt-line);flex:none}
.dsh-bdt-tabs{display:flex;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.dsh-bdt-tab{position:relative;padding:0 10px;border:0;background:transparent;color:var(--bdt-muted);white-space:nowrap;cursor:pointer}
.dsh-bdt-tab:hover{color:var(--bdt-text);background:var(--bdt-soft)}
.dsh-bdt-tab[aria-selected=true]{color:var(--bdt-text)}
.dsh-bdt-tab[aria-selected=true]:after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--bdt-accent)}
.dsh-bdt-pane{display:flex;flex-direction:column;flex:1;min-height:0}
.dsh-bdt-pane[hidden]{display:none}
.dsh-bdt-tools{display:flex;align-items:center;gap:4px;height:27px;flex:none;padding-right:6px;border-bottom:1px solid var(--bdt-line);background:var(--bdt-bar)}
.dsh-bdt-filter{height:20px;min-width:80px;max-width:240px;flex:1;padding:0 6px;border:1px solid transparent;border-radius:3px;background:var(--bdt-bg);outline:none}
.dsh-bdt-filter:focus{border-color:var(--bdt-accent)}
.dsh-bdt-tools select{height:20px;border:0;background:transparent;color:var(--bdt-muted);cursor:pointer}
.dsh-bdt-chips{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none}
.dsh-bdt-chip{height:18px;padding:0 7px;border:0;border-radius:9px;background:transparent;color:var(--bdt-muted);white-space:nowrap;cursor:pointer}
.dsh-bdt-chip:hover{background:var(--bdt-soft)}
.dsh-bdt-chip[aria-pressed=true]{background:var(--bdt-select);color:var(--bdt-text)}
.dsh-bdt-mono{font:11px/1.5 Menlo,Monaco,Consolas,"DejaVu Sans Mono",monospace}
.dsh-bdt-message{margin:auto;padding:16px;color:var(--bdt-muted);text-align:center}
.dsh-bdt-split{display:flex;flex:1;min-height:0}
.dsh-bdt-tree{flex:1;min-width:0;overflow:auto;padding:3px 0;outline:none;user-select:text}
.dsh-bdt-row{position:relative;padding-right:8px;white-space:nowrap;cursor:default}
.dsh-bdt-row:hover{background:var(--bdt-hover)}
.dsh-bdt-row[aria-selected=true]{background:var(--bdt-select-blur)}
.dsh-bdt-tree:focus .dsh-bdt-row[aria-selected=true]{background:var(--bdt-select)}
.dsh-bdt-arrow{position:absolute;width:12px;margin-left:-12px;text-align:center;color:var(--bdt-muted);cursor:pointer;font-size:8px}
.dsh-bdt-tag{color:var(--bdt-tag)}.dsh-bdt-an{color:var(--bdt-attr)}.dsh-bdt-av{color:var(--bdt-value)}.dsh-bdt-comment{color:var(--bdt-comment)}.dsh-bdt-dim{color:var(--bdt-muted)}
.dsh-bdt-side{display:flex;flex-direction:column;width:42%;min-width:220px;border-left:1px solid var(--bdt-line)}
@container (max-width:560px){.dsh-bdt-split{flex-direction:column}.dsh-bdt-side{width:auto;min-width:0;height:45%;border-left:0;border-top:1px solid var(--bdt-line)}}
.dsh-bdt-side .dsh-bdt-bar{height:25px}
.dsh-bdt-scroll{flex:1;min-height:0;overflow:auto}
.dsh-bdt-rule{padding:4px 8px 6px;border-bottom:1px solid var(--bdt-soft)}
.dsh-bdt-rule-head{display:flex;justify-content:space-between;gap:8px}
.dsh-bdt-rule-head span:last-child{color:var(--bdt-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-bdt-decl{padding-left:16px;overflow-wrap:anywhere}
.dsh-bdt-prop{color:var(--bdt-tag)}
.dsh-bdt-note{padding:6px 8px;color:var(--bdt-muted)}
.dsh-bdt-box{margin:10px auto;width:max-content;min-width:240px;text-align:center;font-size:10px;color:#202124}
.dsh-bdt-layer{position:relative;padding:2px 8px;border:1px dashed #333}
.dsh-bdt-margin{background:#f9cc9d}.dsh-bdt-border{background:#fddd9b;border-style:solid;border-color:#000}.dsh-bdt-padding{background:#c3d08b}.dsh-bdt-content{background:#8cb6c0;border-style:solid;border-color:#808080;padding:4px 12px}
.dsh-bdt-layer label{position:absolute;top:1px;left:4px}
.dsh-bdt-sides{display:flex;align-items:center;justify-content:space-between;gap:6px}
.dsh-bdt-computed{display:flex;gap:6px;padding:1px 8px}
.dsh-bdt-computed span:first-child{color:var(--bdt-tag)}
.dsh-bdt-console{flex:1;min-height:0;overflow:auto;user-select:text}
.dsh-bdt-log{display:flex;gap:6px;padding:2px 8px 2px 24px;border-bottom:1px solid var(--bdt-soft);position:relative}
.dsh-bdt-log pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;flex:1;font:inherit}
.dsh-bdt-log svg{position:absolute;left:7px;top:4px;width:12px;height:12px}
.dsh-bdt-log[data-level=warn]{background:var(--bdt-warn-bg);border-color:var(--bdt-warn-line);color:var(--bdt-warn)}
.dsh-bdt-log[data-level=warn] svg{color:var(--bdt-warn-icon)}
.dsh-bdt-log[data-level=error]{background:var(--bdt-error-bg);border-color:var(--bdt-error-line);color:var(--bdt-error)}
.dsh-bdt-log[data-level=debug]{color:var(--bdt-muted)}
.dsh-bdt-log[data-kind=input]:before,.dsh-bdt-log[data-kind=result]:before{position:absolute;left:9px;color:var(--bdt-muted)}
.dsh-bdt-log[data-kind=input]:before{content:'›';color:var(--bdt-accent)}.dsh-bdt-log[data-kind=result]:before{content:'‹'}
.dsh-bdt-log[data-preview=string] pre{color:var(--bdt-string)}.dsh-bdt-log[data-preview=number] pre{color:var(--bdt-number)}.dsh-bdt-log[data-preview=null] pre{color:var(--bdt-muted)}.dsh-bdt-log[data-preview=node] pre{color:var(--bdt-tag)}
.dsh-bdt-count{flex:none;align-self:flex-start;min-width:16px;padding:0 5px;border-radius:8px;background:var(--bdt-muted);color:var(--bdt-bg);font-size:10px;text-align:center}
.dsh-bdt-prompt{display:flex;flex:none;gap:6px;padding:3px 8px 3px 9px;border-top:1px solid var(--bdt-soft)}
.dsh-bdt-prompt:before{content:'›';color:var(--bdt-accent);font-weight:bold}
.dsh-bdt-prompt textarea{flex:1;min-height:17px;max-height:120px;padding:0;border:0;outline:none;resize:none;background:transparent}
.dsh-bdt-table{flex:1;min-height:0;overflow:auto}
.dsh-bdt-table table{width:100%;border-collapse:collapse;table-layout:fixed}
.dsh-bdt-table th{position:sticky;top:0;padding:3px 6px;font-weight:normal;text-align:left;background:var(--bdt-bar);border-bottom:1px solid var(--bdt-line);border-right:1px solid var(--bdt-line);color:var(--bdt-muted);white-space:nowrap}
.dsh-bdt-table td{padding:2px 6px;border-right:1px solid var(--bdt-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-bdt-table tr:nth-child(even) td{background:color-mix(in srgb,var(--bdt-soft) 45%,transparent)}
.dsh-bdt-table tbody tr:hover td{background:var(--bdt-hover)}
.dsh-bdt-table tr[aria-selected=true] td{background:var(--bdt-select)}
.dsh-bdt-table td.bad{color:var(--bdt-error)}
.dsh-bdt-table .num{text-align:right}
.dsh-bdt-status{flex:none;padding:3px 8px;border-top:1px solid var(--bdt-line);background:var(--bdt-bar);color:var(--bdt-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

/** One element with attributes, text and children; values are always set as text, never markup. */
function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, props: Record<string, string | number | boolean | undefined> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value); else if (name === 'text') node.textContent = String(value); else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} kB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
/** The Network panel's type filter for a request. */
export function category(entry: Pick<NetworkEntry, 'type' | 'url'>): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(entry.url, 'http://x/').pathname)?.[1]?.toLowerCase() ?? '';
  if (['fetch', 'xhr', 'xmlhttprequest', 'beacon'].includes(entry.type)) return 'fetch';
  if (['navigation', 'iframe', 'frame'].includes(entry.type) || ext === 'html') return 'doc';
  if (entry.type === 'script' || ['js', 'mjs'].includes(ext)) return 'js';
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
  if (ext === 'css' || entry.type === 'link' && !ext) return 'css';
  if (['img', 'image'].includes(entry.type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp'].includes(ext)) return 'img';
  if (['video', 'audio', 'track'].includes(entry.type) || ['mp4', 'webm', 'mp3', 'ogg', 'wav', 'm4a', 'm3u8'].includes(ext)) return 'media';
  return 'other';
}
const typeLabel = (entry: NetworkEntry) => {
  const kind = category(entry);
  if (kind === 'fetch') return entry.type === 'fetch' ? 'fetch' : 'xhr';
  return ({ js: 'script', css: 'stylesheet', font: 'font', media: 'media', doc: 'document' } as Record<string, string>)[kind]
    ?? (kind === 'img' ? (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(entry.url)?.[1]?.toLowerCase() ?? 'image') : entry.type);
};
const nameOf = (url: string) => {
  try { const parsed = new URL(url); const last = parsed.pathname.split('/').filter(Boolean).pop(); return `${last ?? parsed.host}${parsed.search}`; } catch { return url; }
};

/**
 * Chrome-style debugger docked under one Sidebar Browser page, in DSH's own document.
 * The page only runs a data agent, so page CSS and scripts cannot restyle or remove the panel.
 */
export class DebuggerPanel {
  readonly root: HTMLElement;
  opened = false;
  private tab: Tab = 'elements';
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private epoch = 0;
  private status: 'idle' | 'waiting' | 'connecting' | 'ready' | 'unavailable' = 'idle';
  private logSeq = 0; private netSeq = 0;
  private rows: Row[] = []; private network: NetworkEntry[] = [];
  private tree = new Map<number, TreeNode>(); private rootIds: number[] | undefined;
  private selected: number | undefined; private styles: Styles | null | undefined; private side: 'styles' | 'computed' = 'styles';
  private picking = false; private selectedRequest: number | undefined;
  private filters: Record<Filter, string> = { styles: '', computed: '', console: '', network: '' };
  private level = 'all'; private type = 'all';
  private draft = ''; private history: string[] = []; private historyAt = -1;
  private hovered: number | undefined;
  private parts: Record<string, HTMLElement> = {};
  private readonly style: HTMLStyleElement;
  private readonly navigated = () => { this.reset(); this.status = 'waiting'; this.renderAll(); };
  private readonly loaded = () => { if (this.opened) void this.attach(); };

  constructor(private readonly doc: Document, private readonly view: PanelView, private readonly closed: () => void, private readonly container?: HTMLElement) {
    this.root = h(doc, 'section', { class: 'dsh-bdt-panel', 'data-dsh-browser-devtools': 'panel' });
    this.style = doc.querySelector<HTMLStyleElement>('style[data-dsh-browser-devtools=panel]') ?? h(doc, 'style', { 'data-dsh-browser-devtools': 'panel', text: css });
  }

  /** Dock under the page and connect to it. Throws when the browser layout is not recognized. */
  async open(): Promise<void> {
    if (this.opened) return;
    // `.content > .viewport > webview` in a flex column next to the toolbar form.
    const content = this.view.parentElement?.parentElement;
    if (!this.container && (!content?.parentElement || !Array.from(content.parentElement.children).some(child => child.tagName === 'FORM'))) throw new Error('layout');
    if (!this.style.isConnected) this.doc.head.append(this.style);
    const stored = Number(this.doc.defaultView?.localStorage?.getItem(HEIGHT_KEY));
    this.root.style.height = `${Number.isFinite(stored) && stored >= 120 ? stored : 300}px`;
    if (this.container) {
      this.root.style.height = '100%'; this.root.style.minHeight = '0'; this.root.style.flex = '1';
      this.container.append(this.root);
    } else content!.after(this.root);
    this.opened = true;
    this.view.addEventListener('did-navigate', this.navigated);
    this.view.addEventListener('dom-ready', this.loaded);
    this.renderAll();
    await this.attach();
    if (this.opened) this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    clearInterval(this.timer); this.timer = undefined;
    this.view.removeEventListener('did-navigate', this.navigated);
    this.view.removeEventListener('dom-ready', this.loaded);
    void this.exec(detachScript());
    this.root.remove();
    this.reset(); this.status = 'idle';
    this.closed();
  }

  dispose(): void { if (this.opened) this.close(); }

  /** Labels follow DSH's language. */
  localize(): void { if (this.opened) this.renderAll(); }

  private ready(): boolean { try { return /^https?:\/\//i.test(this.view.getURL()); } catch { return false; } }
  private async exec(code: string): Promise<unknown> {
    const epoch = this.epoch;
    try { const value = await this.view.executeJavaScript(code, false); return epoch === this.epoch ? value : undefined; } catch { return undefined; }
  }
  /** A command for the page agent, reinstalling it once if the page replaced it. */
  private async call<T>(command: string, arg?: unknown): Promise<T | null> {
    let result = await this.exec(commandScript(command, arg));
    if (result === null && this.opened && this.ready() && await this.exec(agentScript()) === true) result = await this.exec(commandScript(command, arg));
    return (result ?? null) as T | null;
  }
  private reset(): void {
    this.epoch++;
    this.logSeq = 0; this.netSeq = 0; this.rows = []; this.network = [];
    this.tree.clear(); this.rootIds = undefined; this.selected = undefined; this.styles = undefined; this.picking = false; this.selectedRequest = undefined;
  }

  private async attach(): Promise<void> {
    const epoch = this.epoch;
    if (!this.ready()) { this.status = 'waiting'; this.renderAll(); return; }
    this.status = 'connecting'; this.renderStatus();
    const installed = await this.exec(agentScript());
    if (!this.opened || epoch !== this.epoch) return;
    if (installed !== true) { this.status = 'unavailable'; this.renderAll(); return; }
    this.status = 'ready';
    this.renderAll();
    await this.loadRoot();
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.opened || this.polling || this.status !== 'ready' || this.doc.hidden) return;
    this.polling = true;
    try {
      const result = await this.call<Poll>('poll', { log: this.logSeq, network: this.netSeq });
      if (!result || !this.opened) return;
      if (result.logs.length) {
        for (const entry of result.logs) {
          const last = this.rows.at(-1);
          if (last?.kind === 'log' && last.entry.level === entry.level && last.entry.text === entry.text) last.count++;
          else this.rows.push({ kind: 'log', entry, count: 1 });
        }
        if (this.rows.length > 1000) this.rows.splice(0, this.rows.length - 1000);
        this.logSeq = result.logs.at(-1)!.seq;
        this.renderConsole();
      }
      if (result.network.length) {
        this.network.push(...result.network);
        if (this.network.length > 1000) this.network.splice(0, this.network.length - 1000);
        this.netSeq = result.network.at(-1)!.seq;
        this.renderNetwork();
      }
      if (this.picking !== result.picking) { this.picking = result.picking; this.renderBar(); }
      if (result.picked) { this.tab = 'elements'; this.renderAll(); await this.reveal(result.picked.path); }
    } finally { this.polling = false; }
  }

  // Elements

  private async loadRoot(): Promise<void> {
    const children = await this.call<NodeSummary[]>('node', { id: 0 });
    if (!children) return;
    for (const node of children) this.tree.set(node.id, { node, expanded: false });
    this.rootIds = children.map(node => node.id);
    const html = children.find(node => node.type === 1 && node.name === 'html');
    if (html) {
      await this.expand(html.id, false);
      const body = this.tree.get(html.id)?.children?.map(id => this.tree.get(id)!).find(item => item.node.type === 1 && item.node.name === 'body');
      if (body) await this.expand(body.node.id, false);
    }
    this.renderTree();
  }
  private async expand(id: number, render = true): Promise<void> {
    const item = this.tree.get(id);
    if (!item) return;
    if (!item.children) {
      const children = await this.call<NodeSummary[]>('node', { id });
      if (!children) return;
      for (const node of children) this.tree.set(node.id, { node, expanded: this.tree.get(node.id)?.expanded ?? false });
      item.children = children.map(node => node.id);
    }
    item.expanded = true;
    if (render) this.renderTree();
  }
  private toggle(id: number): void {
    const item = this.tree.get(id);
    if (!item || !item.node.childCount) return;
    if (item.expanded) { item.expanded = false; this.renderTree(); } else void this.expand(id);
  }
  private async select(id: number): Promise<void> {
    this.selected = id; this.styles = undefined;
    this.renderTree(); this.renderSide();
    await this.call('select', { id });
    const styles = await this.call<Styles>('styles', { id });
    if (this.selected !== id) return;
    this.styles = styles; this.renderSide();
  }
  private async reveal(path: number[]): Promise<void> {
    if (!this.rootIds) await this.loadRoot();
    for (const id of path.slice(0, -1)) await this.expand(id, false);
    const target = path.at(-1);
    if (target === undefined) return;
    if (!this.tree.has(target)) { this.renderTree(); return; }
    await this.select(target);
    this.parts.tree?.querySelector<HTMLElement>(`[data-id="${target}"]`)?.scrollIntoView({ block: 'center' });
    this.parts.tree?.focus();
  }
  /** Row ids in display order, for keyboard movement. */
  private visible(): number[] {
    const list: number[] = [];
    const walk = (ids: number[]) => { for (const id of ids) { list.push(id); const item = this.tree.get(id); if (item?.expanded && item.children) walk(item.children); } };
    walk(this.rootIds ?? []);
    return list;
  }
  private parentOf(id: number): number | undefined {
    for (const [parent, item] of this.tree) if (item.children?.includes(id)) return parent;
    return undefined;
  }

  // Rendering

  private renderAll(): void {
    const doc = this.doc;
    this.root.replaceChildren();
    this.root.setAttribute('aria-label', ui('Page debugger'));
    const resize = h(doc, 'div', { class: 'dsh-bdt-resize', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': ui('Resize debugger') });
    resize.addEventListener('pointerdown', event => this.resize(event, resize));
    const bar = h(doc, 'div', { class: 'dsh-bdt-bar' });
    const panes = h(doc, 'div', { class: 'dsh-bdt-pane' });
    this.parts = { bar, panes };
    if (!this.container) this.root.append(resize);
    this.root.append(bar, panes);
    this.renderBar();
    this.renderStatus();
  }

  private renderBar(): void {
    const doc = this.doc, bar = this.parts.bar;
    if (!bar) return;
    bar.replaceChildren();
    const inspect = h(doc, 'button', { type: 'button', class: 'dsh-bdt-icon', title: ui('Select an element in the page to inspect it'), 'aria-label': ui('Select an element in the page to inspect it'), 'aria-pressed': String(this.picking), disabled: this.status !== 'ready' });
    inspect.innerHTML = ICONS.inspect;
    inspect.addEventListener('click', () => { this.picking = !this.picking; this.renderBar(); void this.call('pick', { on: this.picking }); });
    const tabs = h(doc, 'div', { class: 'dsh-bdt-tabs', role: 'tablist' });
    for (const [id, label] of [['elements', 'Elements'], ['console', 'Console'], ['network', 'Network']] as const) {
      const tab = h(doc, 'button', { type: 'button', role: 'tab', class: 'dsh-bdt-tab', 'aria-selected': String(this.tab === id), text: ui(label) });
      tab.addEventListener('click', () => { this.tab = id; this.renderBar(); this.renderStatus(); });
      tabs.append(tab);
    }
    const close = h(doc, 'button', { type: 'button', class: 'dsh-bdt-icon', title: ui('Close page debugger'), 'aria-label': ui('Close page debugger') });
    close.innerHTML = ICONS.close;
    close.addEventListener('click', () => this.close());
    bar.append(inspect, h(doc, 'span', { class: 'dsh-bdt-sep' }), tabs, close);
  }

  /** The active tab's pane, or a message while the page is not connected. */
  private renderStatus(): void {
    const panes = this.parts.panes;
    if (!panes) return;
    panes.replaceChildren();
    if (this.status !== 'ready') {
      const text = this.status === 'unavailable' ? ui('This page cannot be debugged. Reload it and try again.')
        : this.status === 'connecting' ? ui('Connecting to the page…') : ui('Open a web page to debug it.');
      panes.append(h(this.doc, 'p', { class: 'dsh-bdt-message', role: 'status', text }));
      return;
    }
    if (this.tab === 'elements') this.buildElements(); else if (this.tab === 'console') this.buildConsole(); else this.buildNetwork();
  }

  private buildElements(): void {
    const doc = this.doc;
    const tree = h(doc, 'div', { class: 'dsh-bdt-tree dsh-bdt-mono', role: 'tree', tabindex: 0, 'aria-label': ui('Elements') });
    tree.addEventListener('click', event => {
      const row = (event.target as Element).closest<HTMLElement>('[data-id]');
      if (!row) return;
      const id = Number(row.dataset.id);
      if ((event.target as Element).closest('.dsh-bdt-arrow')) this.toggle(id); else void this.select(id);
    });
    tree.addEventListener('dblclick', event => { const row = (event.target as Element).closest<HTMLElement>('[data-id]'); if (row) this.toggle(Number(row.dataset.id)); });
    tree.addEventListener('mouseover', event => {
      const id = Number((event.target as Element).closest<HTMLElement>('[data-id]')?.dataset.id) || undefined;
      if (id !== this.hovered) { this.hovered = id; void this.call('highlight', { id: id ?? null }); }
    });
    tree.addEventListener('mouseleave', () => { this.hovered = undefined; void this.call('highlight', { id: null }); });
    tree.addEventListener('keydown', event => this.treeKey(event));
    const side = h(doc, 'div', { class: 'dsh-bdt-side' });
    this.parts.tree = tree; this.parts.side = side;
    this.parts.panes.append(h(doc, 'div', { class: 'dsh-bdt-split' }, tree, side));
    this.renderTree(); this.renderSide();
  }

  private treeKey(event: KeyboardEvent): void {
    const order = this.visible();
    if (!order.length) return;
    const at = this.selected === undefined ? -1 : order.indexOf(this.selected);
    const item = this.selected === undefined ? undefined : this.tree.get(this.selected);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = order[Math.min(order.length - 1, at + 1)];
    else if (event.key === 'ArrowUp') next = order[Math.max(0, at - 1)];
    else if (event.key === 'ArrowRight' && item) { if (!item.expanded && item.node.childCount) { this.toggle(item.node.id); event.preventDefault(); return; } next = item.children?.[0]; }
    else if (event.key === 'ArrowLeft' && item) { if (item.expanded) { this.toggle(item.node.id); event.preventDefault(); return; } next = this.parentOf(item.node.id); }
    else return;
    event.preventDefault();
    if (next !== undefined && next !== this.selected) {
      void this.select(next);
      this.parts.tree?.querySelector<HTMLElement>(`[data-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  private renderTree(): void {
    const tree = this.parts.tree;
    if (!tree?.isConnected) return;
    const doc = this.doc, rows: HTMLElement[] = [];
    const span = (cls: string, text: string) => h(doc, 'span', { class: cls, text });
    const row = (id: number | undefined, depth: number, ...content: Node[]) => {
      const node = h(doc, 'div', { class: 'dsh-bdt-row', role: 'treeitem', 'aria-level': depth + 1, ...(id !== undefined ? { 'data-id': id, 'aria-selected': String(id === this.selected) } : {}) }, ...content);
      node.style.paddingLeft = `${depth * 14 + 16}px`;
      rows.push(node);
      return node;
    };
    const walk = (ids: number[], depth: number) => {
      for (const id of ids) {
        const item = this.tree.get(id);
        if (!item) continue;
        const { node } = item;
        if (node.type === 3) { row(id, depth, doc.createTextNode(node.text ?? '')); continue; }
        if (node.type === 8) { row(id, depth, span('dsh-bdt-comment', `<!--${node.text ?? ''}-->`)); continue; }
        if (node.type === 10) { row(id, depth, span('dsh-bdt-dim', `<!DOCTYPE ${node.name}>`)); continue; }
        const open: Node[] = [];
        if (node.childCount) {
          const arrow = h(doc, 'span', { class: 'dsh-bdt-arrow', 'aria-hidden': 'true', text: item.expanded ? '▼' : '▶' });
          open.push(arrow);
        }
        open.push(span('dsh-bdt-tag', `<${node.name}`));
        for (const [name, value] of node.attrs) open.push(doc.createTextNode(' '), span('dsh-bdt-an', name), ...(value === '' ? [] : [span('dsh-bdt-tag', '="'), span('dsh-bdt-av', value), span('dsh-bdt-tag', '"')]));
        open.push(span('dsh-bdt-tag', '>'));
        const closing = VOID.has(node.name) ? [] : [span('dsh-bdt-tag', `</${node.name}>`)];
        if (node.text !== undefined) open.push(doc.createTextNode(node.text), ...closing);
        else if (!node.childCount) open.push(...closing);
        else if (!item.expanded) open.push(span('dsh-bdt-dim', '…'), ...closing);
        if (id === this.selected) open.push(span('dsh-bdt-dim', ' == $0'));
        const element = row(id, depth, ...open);
        if (node.childCount) element.setAttribute('aria-expanded', String(item.expanded));
        if (item.expanded && item.children) { walk(item.children, depth + 1); row(undefined, depth, ...closing); }
      }
    };
    walk(this.rootIds ?? [], 0);
    tree.replaceChildren(...rows);
  }

  private renderSide(): void {
    const side = this.parts.side;
    if (!side?.isConnected) return;
    const doc = this.doc;
    side.replaceChildren();
    const bar = h(doc, 'div', { class: 'dsh-bdt-bar' });
    const tabs = h(doc, 'div', { class: 'dsh-bdt-tabs', role: 'tablist' });
    for (const [id, label] of [['styles', 'Styles'], ['computed', 'Computed']] as const) {
      const tab = h(doc, 'button', { type: 'button', role: 'tab', class: 'dsh-bdt-tab', 'aria-selected': String(this.side === id), text: ui(label) });
      tab.addEventListener('click', () => { this.side = id; this.renderSide(); });
      tabs.append(tab);
    }
    bar.append(tabs);
    const filter = this.filterInput(this.side, () => this.renderSideBody());
    const tools = h(doc, 'div', { class: 'dsh-bdt-tools' }, filter);
    tools.style.paddingLeft = '6px';
    const body = h(doc, 'div', { class: 'dsh-bdt-scroll dsh-bdt-mono' });
    this.parts.sideBody = body;
    side.append(bar, tools, body);
    this.renderSideBody();
  }

  private renderSideBody(): void {
    const body = this.parts.sideBody, doc = this.doc;
    if (!body) return;
    body.replaceChildren();
    if (this.selected === undefined) { body.append(h(doc, 'p', { class: 'dsh-bdt-note', text: ui('No element selected') })); return; }
    if (this.styles === undefined) return;
    if (this.styles === null) { body.append(h(doc, 'p', { class: 'dsh-bdt-note', text: ui('No styles for this node') })); return; }
    const styles = this.styles, needle = this.filters[this.side].toLowerCase();
    const matches = (...values: string[]) => !needle || values.some(value => value.toLowerCase().includes(needle));
    if (this.side === 'computed') {
      body.append(this.boxModel(styles));
      for (const [name, value] of styles.computed) if (matches(name, value)) body.append(h(doc, 'div', { class: 'dsh-bdt-computed' }, h(doc, 'span', { text: name }), h(doc, 'span', { text: value })));
      return;
    }
    const block = (selector: string, source: string, declarations: Styles['inline'], media?: string) => {
      const shown = declarations.filter(d => matches(selector, d.name, d.value));
      if (needle && !shown.length) return;
      const rule = h(doc, 'div', { class: 'dsh-bdt-rule' });
      if (media) rule.append(h(doc, 'div', { class: 'dsh-bdt-dim', text: media }));
      rule.append(h(doc, 'div', { class: 'dsh-bdt-rule-head' }, h(doc, 'span', { text: `${selector} {` }), h(doc, 'span', { text: source, title: source })));
      for (const d of shown) rule.append(h(doc, 'div', { class: 'dsh-bdt-decl' }, h(doc, 'span', { class: 'dsh-bdt-prop', text: d.name }), `: ${d.value}${d.important ? ' !important' : ''};`));
      rule.append(doc.createTextNode('}'));
      body.append(rule);
    };
    block('element.style', '', styles.inline);
    for (const rule of styles.rules) block(rule.selector, rule.source, rule.declarations, rule.media);
    if (styles.blockedSheets) body.append(h(doc, 'p', { class: 'dsh-bdt-note', text: ui('{0} cross-origin stylesheets cannot be read', { 0: styles.blockedSheets }) }));
  }

  private boxModel(styles: Styles): HTMLElement {
    const doc = this.doc, value = (n: number) => n ? String(Math.round(n * 100) / 100) : '-';
    const layer = (kind: string, sides: number[], inner: HTMLElement) => h(doc, 'div', { class: `dsh-bdt-layer dsh-bdt-${kind}` },
      h(doc, 'label', { text: ui(kind) }), h(doc, 'div', { text: value(sides[0]) }),
      h(doc, 'div', { class: 'dsh-bdt-sides' }, h(doc, 'span', { text: value(sides[3]) }), inner, h(doc, 'span', { text: value(sides[1]) })),
      h(doc, 'div', { text: value(sides[2]) }));
    const { box } = styles;
    const content = h(doc, 'div', { class: 'dsh-bdt-layer dsh-bdt-content', text: `${value(box.width)} × ${value(box.height)}` });
    return h(doc, 'div', { class: 'dsh-bdt-box' }, layer('margin', box.margin, layer('border', box.border, layer('padding', box.padding, content))));
  }

  private filterInput(key: Filter, changed: () => void): HTMLInputElement {
    const input = h(this.doc, 'input', { type: 'search', class: 'dsh-bdt-filter', placeholder: ui('Filter'), 'aria-label': ui('Filter'), value: this.filters[key] });
    input.value = this.filters[key];
    input.addEventListener('input', () => { this.filters[key] = input.value; changed(); });
    return input;
  }

  private iconButton(icon: keyof typeof ICONS, label: string, action: () => void): HTMLButtonElement {
    const button = h(this.doc, 'button', { type: 'button', class: 'dsh-bdt-icon', title: label, 'aria-label': label });
    button.innerHTML = ICONS[icon];
    button.addEventListener('click', action);
    return button;
  }

  // Console

  private buildConsole(): void {
    const doc = this.doc;
    const level = h(doc, 'select', { 'aria-label': ui('Log levels') });
    for (const [id, label] of LEVELS) level.append(h(doc, 'option', { value: id, text: ui(label), selected: this.level === id }));
    level.value = this.level;
    level.addEventListener('change', () => { this.level = level.value; this.renderConsole(); });
    const tools = h(doc, 'div', { class: 'dsh-bdt-tools' },
      this.iconButton('clear', ui('Clear console'), () => { this.rows = []; void this.call('clear', 'console'); this.renderConsole(); }),
      this.filterInput('console', () => this.renderConsole()), level);
    const list = h(doc, 'div', { class: 'dsh-bdt-console dsh-bdt-mono', role: 'log', 'aria-label': ui('Console') });
    const input = h(doc, 'textarea', { rows: 1, spellcheck: 'false', 'aria-label': ui('Console prompt'), class: 'dsh-bdt-mono' });
    input.value = this.draft;
    const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
    input.addEventListener('input', () => { this.draft = input.value; this.historyAt = -1; fit(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const code = input.value.trim();
        if (!code) return;
        input.value = ''; this.draft = ''; fit();
        void this.evaluate(code);
      } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !input.value.includes('\n') && this.history.length) {
        event.preventDefault();
        this.historyAt = event.key === 'ArrowUp' ? Math.min(this.history.length - 1, this.historyAt + 1) : Math.max(-1, this.historyAt - 1);
        input.value = this.historyAt < 0 ? '' : this.history[this.history.length - 1 - this.historyAt]; this.draft = input.value; fit();
      }
    });
    // Clicking the log focuses the prompt, as in Chrome, unless text is being selected.
    list.addEventListener('click', () => { if (!this.doc.getSelection?.()?.toString()) input.focus(); });
    this.parts.console = list;
    this.parts.panes.append(tools, list, h(doc, 'div', { class: 'dsh-bdt-prompt' }, input));
    this.renderConsole(true);
  }

  private async evaluate(code: string): Promise<void> {
    const epoch = this.epoch;
    this.history.push(code); if (this.history.length > 100) this.history.shift(); this.historyAt = -1;
    this.rows.push({ kind: 'input', text: code });
    this.renderConsole(true);
    let reply: { result?: Preview; error?: Preview } | undefined;
    try { reply = await this.view.executeJavaScript(evaluateScript(code), true) as typeof reply; }
    catch {
      if (!this.opened || epoch !== this.epoch) return;
      // Statements (`let x = 1; x`) are not expressions: run them as a script and show its completion value.
      try {
        const value = await this.view.executeJavaScript(code, true);
        const kind = typeof value === 'string' ? 'string' : typeof value === 'number' || typeof value === 'boolean' ? 'number' : value === undefined || value === null ? 'null' : 'object';
        reply = { result: { text: typeof value === 'string' ? value : value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value), kind } };
      }
      catch (error) { reply = { error: { text: error instanceof Error ? error.message : String(error), kind: 'error' } }; }
    }
    if (!this.opened || epoch !== this.epoch) return;
    const preview = reply?.error ?? reply?.result ?? { text: 'undefined', kind: 'null' };
    this.rows.push({ kind: 'result', preview: reply?.result?.kind === 'string' ? { ...preview, text: JSON.stringify(preview.text) } : preview, error: Boolean(reply?.error) });
    this.renderConsole(true);
  }

  private renderConsole(stick = false): void {
    const list = this.parts.console;
    if (!list?.isConnected) return;
    const doc = this.doc, atBottom = stick || list.scrollHeight - list.scrollTop - list.clientHeight < 24, needle = this.filters.console.toLowerCase();
    const rows: HTMLElement[] = [];
    for (const row of this.rows) {
      if (row.kind === 'log') {
        const { level, text } = row.entry;
        if (this.level !== 'all' && level !== this.level && !(this.level === 'info' && level === 'log')) continue;
        if (needle && !text.toLowerCase().includes(needle)) continue;
        const item = h(doc, 'div', { class: 'dsh-bdt-log', 'data-level': level, 'data-kind': 'log' }, h(doc, 'pre', { text }), row.count > 1 ? h(doc, 'span', { class: 'dsh-bdt-count', text: row.count }) : null);
        if (level === 'warn' || level === 'error') item.insertAdjacentHTML('afterbegin', ICONS[level]);
        rows.push(item);
      } else if (!needle && this.level === 'all') {
        rows.push(row.kind === 'input'
          ? h(doc, 'div', { class: 'dsh-bdt-log', 'data-kind': 'input' }, h(doc, 'pre', { text: row.text }))
          : h(doc, 'div', { class: 'dsh-bdt-log', 'data-kind': 'result', 'data-level': row.error ? 'error' : undefined, 'data-preview': row.error ? undefined : row.preview.kind }, h(doc, 'pre', { text: row.preview.text })));
      }
    }
    list.replaceChildren(...rows);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // Network

  private buildNetwork(): void {
    const doc = this.doc;
    const chips = h(doc, 'div', { class: 'dsh-bdt-chips', role: 'group', 'aria-label': ui('Request types') });
    for (const [id, label] of TYPES) {
      const chip = h(doc, 'button', { type: 'button', class: 'dsh-bdt-chip', 'aria-pressed': String(this.type === id), text: ui(label) });
      chip.addEventListener('click', () => { this.type = id; for (const other of Array.from(chips.children)) other.setAttribute('aria-pressed', String(other === chip)); this.renderNetwork(); });
      chips.append(chip);
    }
    const tools = h(doc, 'div', { class: 'dsh-bdt-tools' },
      this.iconButton('clear', ui('Clear network log'), () => { this.network = []; this.selectedRequest = undefined; void this.call('clear', 'network'); this.renderNetwork(); }),
      this.filterInput('network', () => this.renderNetwork()), h(doc, 'span', { class: 'dsh-bdt-sep' }), chips);
    const table = h(doc, 'div', { class: 'dsh-bdt-table' });
    table.addEventListener('click', event => {
      const row = (event.target as Element).closest<HTMLElement>('tr[data-seq]');
      if (!row) return;
      this.selectedRequest = Number(row.dataset.seq);
      for (const other of Array.from(table.querySelectorAll('tr[data-seq]'))) other.setAttribute('aria-selected', String(other === row));
    });
    const status = h(doc, 'div', { class: 'dsh-bdt-status' });
    this.parts.network = table; this.parts.networkStatus = status;
    this.parts.panes.append(tools, table, status);
    this.renderNetwork();
  }

  private renderNetwork(): void {
    const table = this.parts.network;
    if (!table?.isConnected) return;
    const doc = this.doc, needle = this.filters.network.toLowerCase();
    const shown = this.network.filter(entry => (this.type === 'all' || category(entry) === this.type) && (!needle || entry.url.toLowerCase().includes(needle)));
    const head = h(doc, 'tr', {});
    for (const [label, width, num] of [['Name', '', false], ['Status', '64px', false], ['Type', '84px', false], ['Size', '76px', true], ['Time', '72px', true]] as const) {
      const cell = h(doc, 'th', { class: num ? 'num' : undefined, text: ui(label) });
      if (width) cell.style.width = width;
      head.append(cell);
    }
    const body = h(doc, 'tbody', {});
    for (const entry of shown) {
      const bad = entry.failed || entry.status >= 400;
      body.append(h(doc, 'tr', { 'data-seq': entry.seq, 'aria-selected': String(entry.seq === this.selectedRequest), title: `${entry.method} ${entry.url}` },
        h(doc, 'td', { class: bad ? 'bad' : undefined, text: nameOf(entry.url) }),
        h(doc, 'td', { class: bad ? 'bad' : undefined, text: entry.failed ? ui('(failed)') : entry.status ? String(entry.status) : '—' }),
        h(doc, 'td', { text: typeLabel(entry) }),
        h(doc, 'td', { class: 'num', text: entry.cached ? ui('(cache)') : entry.size >= 0 ? bytes(entry.size) : '—' }),
        h(doc, 'td', { class: 'num', text: duration(entry.duration) })));
    }
    const atBottom = table.scrollHeight - table.scrollTop - table.clientHeight < 24;
    table.replaceChildren(h(doc, 'table', { class: 'dsh-bdt-mono' }, h(doc, 'thead', {}, head), body));
    if (atBottom) table.scrollTop = table.scrollHeight;
    const transferred = shown.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
    const count = shown.length === this.network.length ? ui('{0} requests', { 0: shown.length }) : ui('{0} / {1} requests', { 0: shown.length, 1: this.network.length });
    if (this.parts.networkStatus) this.parts.networkStatus.textContent = `${count}  |  ${ui('{0} transferred', { 0: bytes(transferred) })}`;
  }

  private resize(event: PointerEvent, handle: HTMLElement): void {
    event.preventDefault();
    const startY = event.clientY, startHeight = this.root.getBoundingClientRect().height;
    const available = (this.root.parentElement?.getBoundingClientRect().height ?? 600) - 160;
    handle.setPointerCapture?.(event.pointerId);
    // The page's native view would otherwise swallow the drag once the pointer crosses it.
    const pointer = this.view.style.pointerEvents;
    this.view.style.pointerEvents = 'none';
    const move = (next: PointerEvent) => { this.root.style.height = `${Math.max(120, Math.min(available, startHeight + startY - next.clientY))}px`; };
    const end = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      this.view.style.pointerEvents = pointer;
      try { this.doc.defaultView?.localStorage?.setItem(HEIGHT_KEY, String(Math.round(this.root.getBoundingClientRect().height))); } catch { /* Storage unavailable. */ }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }
}
