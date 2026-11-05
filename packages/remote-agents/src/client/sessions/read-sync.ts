import { api } from '../api.js';
import type { Client } from '../index.js';

const POLL_MS = 5000, MARK_LIMIT = 500;

interface Row { running?: boolean; retainedBy?: Record<string, number> }
interface SessionList { getSnapshot(): { byId?: Record<string, Row> } | undefined; subscribe(listener: () => void): () => void }
/**
 * The part of DSH's `uiSession` service that holds finished, unread sessions. It is kept in the page and has no way to
 * clear one from outside, hence the two private members, which DSH's own service changes the same way.
 */
interface UiSession {
  sessionStatus?: { getSnapshot(): ReadonlyMap<string, { completionUnread?: boolean }>; subscribe(listener: () => void): () => void };
  completionUnread?: Set<string>;
  publishStatus?(): void;
}

export interface ReadSyncPage {
  /** The conversation on screen, if any. */
  main(): { id: string; running: boolean } | undefined;
  running(): string[];
  unread(): string[];
  /** The window is on screen and in use: a conversation it shows is really being looked at. */
  attending(): boolean;
  visible(): boolean;
  markRead(id: string): Promise<unknown>;
  marks(ids: string[]): Promise<Record<string, string>>;
  clear(ids: string[]): void;
}

/**
 * A finished turn counts as read on every DSH and phone sharing its conversation, wherever the user looked at it. Each
 * read is told to the host when a conversation is on screen, and sessions this page still shows as unread are cleared
 * once someone else has read them. A read from before a turn began says nothing about that turn; the mark taken as it
 * begins tells them apart, for example for a DSH model's turn, which the shared history does not record.
 */
export class ReadSync {
  /** The conversation already reported, until it runs again. */
  private told?: string;
  /** Read marks as turns began; `null` when there was none. */
  private readonly atStart = new Map<string, string | null>();
  private readonly asking = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly page: ReadSyncPage) {}

  /** Call on every change of the page's sessions, focus or visibility. */
  check(): void {
    if (this.closed) return;
    this.tell();
    this.rememberStarts();
    if (this.page.visible() && this.page.unread().length > 0 && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 0);
  }

  close(): void { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }

  private tell(): void {
    const main = this.page.main();
    if (main?.running) { this.told = undefined; return; }
    if (!main || !this.page.attending() || this.told === main.id) return;
    this.told = main.id;
    void this.page.markRead(main.id).catch(() => {});
  }

  private rememberStarts(): void {
    const running = this.page.running(), unread = new Set(this.page.unread());
    for (const id of this.atStart.keys()) if (!running.includes(id) && !unread.has(id)) this.atStart.delete(id);
    const fresh = running.filter(id => !this.atStart.has(id) && !this.asking.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.asking.add(id);
    void this.page.marks(fresh).then(marks => {
      for (const id of fresh) this.atStart.set(id, marks[id] ?? null);
    }, () => {}).finally(() => { for (const id of fresh) this.asking.delete(id); });
  }

  private async poll(): Promise<void> {
    const unread = this.page.unread();
    if (this.closed || unread.length === 0 || !this.page.visible()) return;
    try {
      const marks = await this.page.marks(unread.slice(0, MARK_LIMIT));
      if (this.closed) return;
      const read = unread.filter(id => marks[id] && marks[id] !== this.atStart.get(id));
      if (read.length > 0) {
        for (const id of read) this.atStart.delete(id);
        this.page.clear(read);
      }
    } catch { /* it asks again */ }
    if (!this.closed && !this.timer && this.page.unread().length > 0) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, POLL_MS);
  }
}

export function installReadSync(ctx: Client): void {
  ctx.inject?.(['uiSession', 'sessions'], scoped => {
    const get = scoped.get as unknown as (name: string) => unknown;
    const ui = get('uiSession') as UiSession, list = (get('sessions') as { list?: SessionList }).list;
    if (!list) return;
    scoped.effect(() => {
      const rows = () => Object.entries(list.getSnapshot()?.byId ?? {});
      const sync = new ReadSync({
        main: () => {
          const found = rows().find(([, row]) => (row.retainedBy?.mainView ?? 0) > 0);
          return found ? { id: found[0], running: !!found[1].running } : undefined;
        },
        running: () => rows().filter(([, row]) => row.running).map(([id]) => id),
        unread: () => ui.completionUnread instanceof Set && ui.publishStatus && ui.sessionStatus
          ? [...ui.sessionStatus.getSnapshot()].filter(([, status]) => status.completionUnread).map(([id]) => id) : [],
        attending: () => document.visibilityState === 'visible' && document.hasFocus(),
        visible: () => document.visibilityState === 'visible',
        markRead: id => api('markChatRead', { sessionId: id }),
        marks: async ids => (await api<{ marks: Record<string, string> }>('chatReadMarks', { sessionIds: ids })).marks,
        clear: ids => { for (const id of ids) ui.completionUnread?.delete(id); ui.publishStatus?.(); },
      });
      const check = () => sync.check();
      const stops = [list.subscribe(check), ui.sessionStatus?.subscribe(check)];
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', check);
      check();
      return () => {
        sync.close();
        for (const stop of stops) stop?.();
        window.removeEventListener('focus', check);
        document.removeEventListener('visibilitychange', check);
      };
    });
  });
}
