/** What the Assets tab shows of a scan: filtering, the folder tree, and how values read. */
import type { Asset, Usage } from '../domain.js';

/** `retired` lists the retired folder; every other filter leaves retired images out. */
export type UsageFilter = 'all' | Usage | 'dup' | 'retired';
/** `tag` is a tag, {@link UNTAGGED}, or empty for any. */
export interface Filter { query: string; usage: UsageFilter; folder: string; tag?: string }
export const USAGE_FILTERS: readonly UsageFilter[] = ['all', 'used', 'maybe', 'unused', 'dup', 'retired'];
export const UNTAGGED = '\u0001';

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const dirOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const stemOf = (path: string) => nameOf(path).replace(/\.[A-Za-z0-9]+$/, '');
export const inFolder = (path: string, folder: string) => !folder || path.startsWith(`${folder}/`);

const terms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);
/** Search words are looked for in the path, the tags and the note. */
const matchesQuery = (asset: Asset, words: string[]) => {
  if (!words.length) return true;
  const text = `${asset.path}\n${asset.tags?.join('\n') ?? ''}\n${asset.note ?? ''}`.toLowerCase();
  return words.every(word => text.includes(word));
};
const matchesUsage = (asset: Asset, usage: UsageFilter) => usage === 'retired' ? !!asset.retired
  : !asset.retired && (usage === 'all' || (usage === 'dup' ? asset.dup !== undefined : asset.usage === usage));
const matchesTag = (asset: Asset, tag: string | undefined) => !tag || (tag === UNTAGGED ? !asset.tags?.length : !!asset.tags?.includes(tag));

/** Images that pass the search, the usage filter and the folder, in scan order (by path). */
export function filterAssets(assets: readonly Asset[], filter: Filter): Asset[] {
  const words = terms(filter.query);
  return assets.filter(asset => inFolder(asset.path, filter.folder) && matchesUsage(asset, filter.usage) && matchesTag(asset, filter.tag) && matchesQuery(asset, words));
}
/** How many images each usage filter would show under the current search and folder. */
export function usageCounts(assets: readonly Asset[], filter: Filter): Record<UsageFilter, number> {
  const words = terms(filter.query), counts: Record<UsageFilter, number> = { all: 0, used: 0, maybe: 0, unused: 0, dup: 0, retired: 0 };
  for (const asset of assets) {
    if (!matchesTag(asset, filter.tag) || !matchesQuery(asset, words)) continue;
    // Retired images sit in their own folder, so the folder picked among live images does not narrow them.
    if (asset.retired) { if (filter.usage !== 'retired' || inFolder(asset.path, filter.folder)) counts.retired++; continue; }
    if (filter.usage !== 'retired' && !inFolder(asset.path, filter.folder)) continue;
    counts.all++; counts[asset.usage]++;
    if (asset.dup !== undefined) counts.dup++;
  }
  return counts;
}

export interface TreeNode { path: string; label: string; count: number; children: TreeNode[] }
/**
 * Folders of the images that pass the search and usage filter, each with the number of images below it. A folder whose
 * only content is one subfolder is shown merged with it, as `assets/generated`.
 */
export function buildTree(assets: readonly Asset[], filter: Filter): TreeNode {
  interface Raw { path: string; label: string; count: number; own: number; children: Map<string, Raw> }
  const words = terms(filter.query), root: Raw = { path: '', label: '', count: 0, own: 0, children: new Map() };
  for (const asset of assets) {
    if (!matchesUsage(asset, filter.usage) || !matchesTag(asset, filter.tag) || !matchesQuery(asset, words)) continue;
    const parts = asset.path.split('/');
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.children.get(parts[i]);
      if (!child) node.children.set(parts[i], child = { path: parts.slice(0, i + 1).join('/'), label: parts[i], count: 0, own: 0, children: new Map() });
      child.count++;
      node = child;
    }
    node.own++;
  }
  const finish = (raw: Raw): TreeNode => {
    let node = raw, label = raw.label;
    while (node !== root && node.own === 0 && node.children.size === 1) { node = node.children.values().next().value!; label = `${label}/${node.label}`; }
    return { path: node.path, label, count: node.count, children: [...node.children.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map(finish) };
  };
  return finish(root);
}

export type Sort = 'path' | 'size' | 'pixels';
export function sortAssets(assets: Asset[], sort: Sort): Asset[] {
  if (sort === 'path') return assets;
  const value = (asset: Asset) => sort === 'size' ? asset.size : (asset.width ?? 0) * (asset.height ?? 0);
  return [...assets].sort((a, b) => value(b) - value(a) || (a.path < b.path ? -1 : 1));
}

/** Other images with the same file name, whatever their extension: copies, masters and other versions of one picture. */
export function sameName(assets: readonly Asset[]): (asset: Asset) => Asset[] {
  const byStem = new Map<string, Asset[]>();
  for (const asset of assets) { const stem = stemOf(asset.path), list = byStem.get(stem); if (list) list.push(asset); else byStem.set(stem, [asset]); }
  return asset => (byStem.get(stemOf(asset.path)) ?? []).filter(other => other !== asset);
}

/** Every tag in use with the number of images that carry it, most used first. */
export function tagCounts(assets: readonly Asset[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const asset of assets) for (const tag of asset.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A message for the agent of the conversation: what to do, then the images it is about. */
export function agentMessage(instruction: string, paths: readonly string[], more: (count: number) => string, limit = 400): string {
  const listed = paths.slice(0, limit).map(path => `- ${path}`);
  if (paths.length > limit) listed.push(more(paths.length - limit));
  return `${instruction.trim()}\n\n${listed.join('\n')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** How a small sprite is enlarged to fill a box: by whole pixels, so pixel art stays sharp. */
export function fitScale(width: number | undefined, height: number | undefined, box: number): number | undefined {
  if (!width || !height) return undefined;
  const scale = Math.floor(box / Math.max(width, height));
  return scale >= 2 ? scale : undefined;
}

/** Rows of a grid that are on screen, with `overscan` rows of margin. */
export function visibleRows(count: number, columns: number, rowHeight: number, scrollTop: number, viewHeight: number, overscan = 2) {
  const rows = Math.ceil(count / columns);
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan), last = Math.min(rows - 1, Math.floor((scrollTop + viewHeight) / rowHeight) + overscan);
  return { rows, first, last };
}
