import { activeLocale } from './i18n.js';
import { releaseScript } from './guest.js';
import type { Command, PageState, Reply, SessionKey } from '../protocol.js';

/** The small subset of Electron's webview tag used by the client plugin. */
export interface Inspectable extends EventTarget {
  getURL(): string;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export type OwnerRequest = <T>(input: Record<string, unknown>) => Promise<T>;
export const ownerRequest: OwnerRequest = async <T>(input: Record<string, unknown>): Promise<T> => {
  const response = await fetch('/api/browser-devtools', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Debugger': '1' },
    body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not connect to the debugger window.');
  return result as T;
};
export interface DetachedState { opened: boolean; busy: boolean; error?: string }

/** Owns exactly one page. Commands never follow the currently selected tab. */
export class DetachedDebugger {
  private key?: SessionKey;
  private revision = 0;
  private ready = true;
  private stopped = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private replies: Reply[] = [];
  private state: DetachedState = { opened: false, busy: false };
  private readonly listeners: Record<string, EventListener>;
  constructor(private readonly doc: Document, private readonly view: Inspectable,
    private readonly changed: (state: DetachedState) => void, private readonly request: OwnerRequest = ownerRequest) {
    this.listeners = {
      'did-start-navigation': event => {
        const nav = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
        if (nav.isMainFrame !== false && !nav.isInPlace) this.navigate();
      },
      'did-navigate': () => this.navigate(),
      'dom-ready': () => { this.ready = true; },
      'render-process-gone': () => { void this.close(); },
      destroyed: () => { void this.close(); },
    };
    for (const [event, listener] of Object.entries(this.listeners)) view.addEventListener(event, listener);
  }
  get opened() { return this.state.opened; }
  private emit(patch: Partial<DetachedState>) { this.state = { ...this.state, ...patch }; if (!this.stopped) this.changed(this.state); }
  private navigate() { this.revision++; this.ready = false; this.replies = []; }
  private page(): PageState {
    let url = ''; try { url = this.view.getURL(); } catch { /* Guest destroyed. */ }
    return { url: url.slice(0, 8192), title: '', revision: this.revision, ready: this.ready && /^https?:\/\//i.test(url),
      locale: activeLocale(), dark: this.doc.body.hasAttribute('data-ds-dark-theme') };
  }
  async open(): Promise<void> {
    if (this.stopped || this.key || this.state.busy) return;
    const generation = ++this.generation;
    this.emit({ busy: true, error: undefined });
    try {
      const key = await this.request<SessionKey>({ action: 'create', page: this.page() });
      if (this.stopped || generation !== this.generation) { await this.request({ action: 'close', ...key }); return; }
      this.key = key; this.emit({ opened: true });
      void this.pump(generation);
    } catch (error) {
      if (generation === this.generation) this.emit({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (generation === this.generation) this.emit({ busy: false }); }
  }
  private async pump(generation: number): Promise<void> {
    if (!this.key || generation !== this.generation || this.stopped) return;
    try {
      const result = await this.request<{ commands: Command[] }>({ action: 'exchange', ...this.key, page: this.page(), replies: this.replies.splice(0, 2) });
      if (generation !== this.generation || this.stopped) return;
      for (const command of result.commands) void this.execute(command, generation);
      this.timer = setTimeout(() => { void this.pump(generation); }, 200);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.close();
      if (message !== 'Debugger window closed') this.emit({ error: message });
    }
  }
  private async execute(command: Command, generation: number): Promise<void> {
    if (generation !== this.generation || command.revision !== this.revision || !this.page().ready) return;
    let reply: Reply;
    try {
      const value = await this.view.executeJavaScript(command.code, command.gesture);
      // Match the bridge's bounded payload; cyclic/non-serializable console results become errors.
      const json = JSON.stringify(value ?? null);
      if (new TextEncoder().encode(json).length > 1_000_000) throw new Error('Debugger result is too large.');
      reply = { id: command.id, value: JSON.parse(json) };
    } catch (error) { reply = { id: command.id, error: String(error instanceof Error ? error.message : error).slice(0, 2048) }; }
    if (generation === this.generation && command.revision === this.revision) this.replies.push(reply);
  }
  dismiss() { this.emit({ error: undefined }); }
  async close(): Promise<void> {
    const key = this.key; this.key = undefined; this.generation++;
    clearTimeout(this.timer); this.replies = [];
    this.emit({ opened: false, busy: false });
    if (key) {
      // The page agent keeps recording for the next window; only this session's picking and highlight end.
      const release = this.view.executeJavaScript(releaseScript(), false).catch(() => {});
      await Promise.all([release, this.request({ action: 'close', ...key }).catch(() => {})]);
    }
  }
  dispose(): void {
    this.stopped = true;
    for (const [event, listener] of Object.entries(this.listeners)) this.view.removeEventListener(event, listener);
    void this.close();
  }
}
