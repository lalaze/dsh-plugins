import type { TimelineEntry, TimelinePage } from '../../core/domain.js';

export interface TimelineState extends Omit<TimelinePage, 'reset' | 'staleCursor' | 'gap'> {}
export const emptyTimeline = (): TimelineState => ({ epoch: '', entries: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false });
export function mergeTimeline(previous: TimelineState, page: TimelinePage, older = false): TimelineState {
  const reset = page.reset || page.staleCursor || page.gap || previous.epoch !== page.epoch;
  const unique = new Map((reset ? [] : previous.entries).map(e => [e.seqStart, e]));
  for (const entry of page.entries) unique.set(entry.seqStart, entry);
  return { epoch: page.epoch, entries: [...unique.values()].sort((a, b) => a.seqStart - b.seqStart),
    startCursor: reset ? page.startCursor : older || !previous.startCursor ? page.startCursor ?? previous.startCursor : previous.startCursor,
    endCursor: reset ? page.endCursor : older ? previous.endCursor : page.endCursor ?? previous.endCursor,
    hasOlder: reset || older ? page.hasOlder : previous.hasOlder, hasNewer: !reset && older ? previous.hasNewer : page.hasNewer };
}
export interface TimelineRow { key: number; kind: string; text: string; detail?: string; status?: string; timestamp?: string }
export function timelineRows(entries: TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [], tools = new Map<string, TimelineRow>();
  const confirmed = new Set(entries.filter(e => e.item.type === 'delivery').map(e => e.item.clientMessageId));
  let textRow: TimelineRow | undefined, turn: string | undefined;
  for (const entry of entries) {
    const item = entry.item;
    if (item.type === 'delivery') continue;
    if (item.type === 'user_message' || item.type === 'turn_end' || (turn && entry.turnId && turn !== entry.turnId)) { tools.clear(); textRow = undefined; }
    if (entry.turnId) turn = entry.turnId;
    if (item.type === 'turn_end') continue;
    if (item.type === 'tool_call') {
      textRow = undefined;
      const id = String(item.callId ?? entry.seqStart), existing = tools.get(id);
      const detail = typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail ?? {}, null, 2);
      const value = { key: existing?.key ?? entry.seqStart, kind: item.type, timestamp: entry.timestamp, text: String(item.name ?? 'Tool'), detail, status: String(item.status ?? '') };
      if (existing) Object.assign(existing, value); else { tools.set(id, value); rows.push(value); }
      continue;
    }
    const text = typeof item.text === 'string' ? item.text : typeof item.message === 'string' ? item.message : '';
    if (!text && item.type !== 'interrupted') continue;
    if ((item.type === 'assistant_message' || item.type === 'reasoning') && textRow?.kind === item.type) textRow.text += text;
    else {
      const row: TimelineRow = { key: entry.seqStart, kind: item.type, text, timestamp: entry.timestamp,
        ...(item.type === 'user_message' && item.delivery === 'pending' && !confirmed.has(item.clientMessageId) ? { status: 'unconfirmed' } : {}) }; rows.push(row);
      textRow = item.type === 'assistant_message' || item.type === 'reasoning' ? row : undefined;
    }
  }
  return rows;
}
