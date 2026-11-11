/** The bugs waiting to be handed out: what the last fetch found, and where each one should go. */
import { itemKey, type Assignment, type Item, type PoolItem } from './domain.js';

export type Pool = Record<string, PoolItem>;

const BRACKETS: readonly [string, string][] = [['【', '】'], ['[', ']'], ['（', '）'], ['(', ')']];
const SEPARATOR = /[\s:：;；|｜\-—_、]/u;
/** What a team writes in front of a bug's title to say where it belongs, as `【活动页】` or `H5:`. */
export function titlePrefix(title: string): string | undefined {
  const trimmed = title.trim();
  for (const [open, close] of BRACKETS) {
    if (!trimmed.startsWith(open)) continue;
    const end = trimmed.indexOf(close);
    return end > open.length ? trimmed.slice(0, end + close.length) : undefined;
  }
  const at = trimmed.search(SEPARATOR);
  if (at < 0) return undefined;
  const prefix = trimmed.slice(0, at).trim(), length = [...prefix].length;
  return length >= 2 && length <= 40 ? prefix : undefined;
}

/**
 * A source's open bugs merged in: new ones added, known ones refreshed. With `complete`, the source's bugs that are
 * missing are marked stale; a source that only hands some in says nothing about the rest. What a person chose stays.
 */
export function refresh(pool: Pool, source: string, items: readonly Item[], now: number, complete = true): { pool: Pool; added: number } {
  const next: Pool = { ...pool }, seen = new Set<string>();
  let added = 0;
  for (const item of items) {
    const key = itemKey(item), known = pool[key];
    if (item.source !== source || seen.has(key)) continue;
    seen.add(key);
    if (!known) added++;
    const { stale: _stale, ...kept } = known ?? { key, firstSeen: now };
    next[key] = { ...kept, key, item, lastSeen: now } as PoolItem;
  }
  if (complete) for (const [key, entry] of Object.entries(pool)) if (entry.item.source === source && !seen.has(key)) next[key] = { ...entry, stale: true };
  return { pool: next, added };
}
/** What is remembered about where bugs go, by `prefix:<source>:<title prefix>` and `project:<source>:<project id>`. */
export type Memory = Readonly<Record<string, Assignment>>;
export const prefixKey = (item: Pick<Item, 'source' | 'title'>) => { const prefix = titlePrefix(item.title); return prefix ? `prefix:${item.source}:${prefix}` : undefined; };
export const projectKey = (item: Pick<Item, 'source' | 'project'>) => item.project ? `project:${item.source}:${item.project.id}` : undefined;
/**
 * Where a bug like this went before. Bugs of the same source with the same title prefix decide, when they all agree
 * (two answers for one prefix is no answer); then what accepted fixes taught: the prefix, then the source's project,
 * which names a repository and a branch but no package.
 */
export function suggest(pool: Pool, item: Pick<Item, 'source' | 'title' | 'project'>, memory: Memory = {}): Assignment | undefined {
  const prefix = titlePrefix(item.title);
  if (prefix) {
    const found = Object.values(pool).flatMap(entry => entry.assignment && entry.item.source === item.source && titlePrefix(entry.item.title) === prefix ? [entry.assignment] : []);
    const same = (a: Assignment, b: Assignment) => a.routeId === b.routeId && a.branch === b.branch && (a.package ?? '') === (b.package ?? '');
    if (found.length) return found.every(entry => same(entry, found[0])) ? found[0] : undefined;
    const known = memory[prefixKey(item)!];
    if (known) return known;
  }
  const key = projectKey(item);
  return key ? memory[key] : undefined;
}
/** Lists for a page: waiting first, newest first; dismissed and stale ones last. */
export function ordered(pool: Pool): PoolItem[] {
  const rank = (item: PoolItem) => item.dismissed ? 2 : item.stale ? 1 : 0;
  return Object.values(pool).sort((a, b) => rank(a) - rank(b) || b.firstSeen - a.firstSeen || a.key.localeCompare(b.key));
}
