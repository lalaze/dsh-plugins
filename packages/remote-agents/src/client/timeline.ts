import type { TimelineEntry, TimelinePage } from '../domain.js';

export interface TimelineState {
  epoch: string;
  entries: TimelineEntry[];
  startCursor: TimelinePage['startCursor'];
  endCursor: TimelinePage['endCursor'];
  hasOlder: boolean;
  hasNewer: boolean;
}
export const emptyTimeline = (): TimelineState => ({ epoch: '', entries: [], startCursor: null, endCursor: null, hasOlder: false, hasNewer: false });
export function mergeTimeline(previous: TimelineState, page: TimelinePage, older = false): TimelineState {
  const reset = page.reset || page.staleCursor || page.gap || previous.epoch !== page.epoch;
  const source = reset ? [] : previous.entries;
  const unique = new Map(source.map(e => [`${e.seqStart}:${e.seqEnd}`, e]));
  for (const entry of page.entries) unique.set(`${entry.seqStart}:${entry.seqEnd}`, entry);
  const entries = [...unique.values()].sort((a, b) => a.seqStart - b.seqStart);
  return {
    epoch: page.epoch, entries,
    startCursor: reset ? page.startCursor : older || !previous.startCursor ? page.startCursor ?? previous.startCursor : previous.startCursor,
    endCursor: reset || !older ? page.endCursor ?? (reset ? null : previous.endCursor) : previous.endCursor,
    hasOlder: reset || older ? page.hasOlder : previous.hasOlder,
    hasNewer: older ? previous.hasNewer : page.hasNewer,
  };
}
export interface TimelineRow { key: string; kind: string; text: string; detail?: string; status?: string }
export function timelineRows(entries: TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = [], tools = new Map<string, TimelineRow>();
  for (const entry of entries) {
    const item = entry.item;
    if (item.type === 'delivery') continue;
    const key = `${entry.seqStart}:${entry.seqEnd}`;
    if (item.type === 'tool_call') {
      const callId = String(item.callId ?? key), row = tools.get(callId);
      const text = typeof item.name === 'string' ? item.name : 'Tool';
      const detail = JSON.stringify(item.detail ?? item.output ?? item.input ?? {}, null, 2);
      if (row) { row.text = text; row.detail = detail; row.status = String(item.status ?? ''); }
      else { const next = { key, kind: 'tool_call', text, detail, status: String(item.status ?? '') }; tools.set(callId, next); rows.push(next); }
      continue;
    }
    const text = typeof item.text === 'string' ? item.text : typeof item.message === 'string' ? item.message : JSON.stringify(item, null, 2);
    const last = rows.at(-1);
    if ((item.type === 'assistant_message' || item.type === 'reasoning') && last?.kind === item.type && (!entry.turnId || last.key.startsWith(`${entry.turnId}:`))) last.text += text;
    else rows.push({ key: `${entry.turnId ?? ''}:${key}`, kind: item.type, text });
  }
  return rows;
}
