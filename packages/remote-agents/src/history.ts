import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cursor, MessageTimeline, TimelineEntry, TimelinePage } from './domain.js';

export class TaskHistory {
  private entries: TimelineEntry[] = [];
  private queue = Promise.resolve();
  private failure?: unknown;
  readonly epoch: string;
  constructor(private readonly directory: string, private readonly taskId: string) { this.epoch = `task-${taskId}`; }
  async open(): Promise<void> {
    let data: string;
    try { data = await readFile(join(this.directory, 'events', `${this.taskId}.jsonl`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (data && !data.endsWith('\n')) throw new Error('Task history has an incomplete record; restore its event log before continuing');
    const lines = data.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      let entry: TimelineEntry;
      try { entry = JSON.parse(lines[i]); } catch { throw new Error('Task history is damaged; restore its event log before continuing'); }
      if (entry.seqStart !== this.entries.length + 1 || entry.seqEnd !== entry.seqStart || typeof entry.item?.type !== 'string') throw new Error('Invalid task history sequence');
      this.entries.push(entry);
    }
  }
  append(item: TimelineEntry['item'], turnId?: string): Promise<void> {
    const saved = structuredClone(item);
    const next = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const seq = this.entries.length + 1;
      const entry: TimelineEntry = { seqStart: seq, seqEnd: seq, timestamp: new Date().toISOString(), item: saved, ...(turnId ? { turnId } : {}) };
      await mkdir(join(this.directory, 'events'), { recursive: true, mode: 0o700 });
      await appendFile(join(this.directory, 'events', `${this.taskId}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      this.entries.push(entry);
    });
    this.queue = next.catch(error => { this.failure = error; }); return next;
  }
  async page(cursor?: Cursor, direction: 'before' | 'after' = 'before'): Promise<TimelinePage> {
    await this.queue;
    const reset = !!cursor && cursor.epoch !== this.epoch;
    const selected = this.entries.filter(e => !cursor || reset || (direction === 'after' ? e.seqStart > cursor.seq : e.seqStart < cursor.seq));
    const entries = direction === 'after' && !reset ? selected.slice(0, 100) : selected.slice(-100);
    const first = entries[0]?.seqStart, last = entries.at(-1)?.seqEnd;
    return { epoch: this.epoch, reset, staleCursor: reset, gap: false, entries: structuredClone(entries), startCursor: first ? { epoch: this.epoch, seq: first } : null, endCursor: last ? { epoch: this.epoch, seq: last } : null, hasOlder: !!first && first > 1, hasNewer: !!last && last < this.entries.length };
  }
  async hasMessage(id: string): Promise<boolean> { await this.queue; return this.entries.some(e => e.item.type === 'user_message' && e.item.clientMessageId === id); }
  async messagePage(messageId: string, cursor?: Cursor): Promise<MessageTimeline> {
    await this.queue;
    return messageTimeline(this.entries, this.epoch, messageId, cursor);
  }
  /** Assistant text written since the latest user message, for delegation results. */
  async lastReply(): Promise<string> {
    await this.queue;
    const parts: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].item.type !== 'user_message'; i--) {
      const item = this.entries[i].item;
      if (item.type === 'assistant_message' && typeof item.text === 'string') parts.push(item.text);
    }
    return parts.reverse().join('');
  }
  async flush(): Promise<void> { await this.queue; }
  async remove(): Promise<void> {
    await this.queue.catch(() => {});
    this.failure = new Error('Agent history was deleted');
    await rm(join(this.directory, 'events', `${this.taskId}.jsonl`), { force: true });
  }
}

export function messageTimeline(all: TimelineEntry[], epoch: string, messageId: string, cursor?: Cursor): MessageTimeline {
  if (cursor && cursor.epoch !== epoch) throw new Error('Remote message history changed');
  const start = all.findIndex(e => e.item.type === 'user_message' && e.item.clientMessageId === messageId);
  const next = start < 0 ? -1 : all.findIndex((e, i) => i > start && e.item.type === 'user_message');
  const selected = start < 0 ? [] : all.slice(start + 1, next < 0 ? undefined : next).filter(e => !cursor || e.seqStart > cursor.seq);
  const entries = structuredClone(selected.slice(0, 100));
  const deliveryConfirmed = start >= 0 && (all[start].item.delivery !== 'pending' || all.slice(start + 1, next < 0 ? undefined : next).some(e => e.item.type === 'delivery' && e.item.clientMessageId === messageId));
  const terminal = start < 0 ? undefined : all.slice(start + 1, next < 0 ? undefined : next).findLast(e => e.item.type === 'turn_end' && e.item.clientMessageId === messageId);
  return { found: start >= 0, deliveryConfirmed, hasFollowingMessage: next >= 0, ...(terminal ? { terminalStatus: String(terminal.item.status) } : {}), epoch, entries, reset: false, staleCursor: false, gap: false,
    startCursor: entries.length ? { epoch, seq: entries[0].seqStart } : null,
    endCursor: entries.length ? { epoch, seq: entries.at(-1)!.seqEnd } : cursor ?? null,
    hasOlder: false, hasNewer: selected.length > entries.length };
}
