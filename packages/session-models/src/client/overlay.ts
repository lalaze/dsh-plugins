import { BRAND_COLORS, describeSelection, iconUrl, type BrandId, type ModelBadge, type Selection } from './brands.js';

interface Projection {
  readonly values?: { readonly modelSelection?: { readonly next: Selection | null; readonly lastUsed: Selection | null } };
  readonly state?: string;
}
export interface SessionList { readonly projectionsBySession?: Readonly<Record<string, Projection>> }
/** The part of DSH's `ctx.sessions` this plugin reads. */
export interface Sessions {
  readonly list: { getSnapshot(): SessionList | undefined; subscribe(listener: () => void): () => void };
  refreshProjections(sessionId: string): Promise<void>;
}

export const STYLE_ID = 'dsh-session-models';
const ROW = '[data-row-key^="session:"]';
const SAFE_ID = /^[\w-]+$/;
const MONO = 'var(--dsw-alias-label-primary,currentColor)';

// The host owns the row markup; a stylesheet decorates it without touching React's nodes.
// The leading cell is 16x20. The icon fills it, and whatever status mark the host renders there
// (state dot, running spinner, schedule clock) shrinks into the icon's lower-right corner.
// The icon gets a transparent cut-out behind that badge, so it reads on any sidebar background.
const CELL = `${ROW}>span:first-child`;
// Status marks may sit directly in the cell or inside a host wrapper; the badge moves whichever child holds them.
const DOT = '[data-state]:not(svg)', SPIN = 'svg[data-state]', MARK = '[data-session-schedule-mark]';
const holding = (mark: string) => `:is(${mark},:has(${mark}))`;
const MASK = ['-webkit-mask', 'mask'].map(p => `${p}-image:radial-gradient(circle at 12.5px 12.5px,transparent var(--dsm-cut,0px),#000 calc(var(--dsm-cut,0px) + .5px)),var(--dsm-icon,none);${p}-size:100% 100%,contain;${p}-repeat:no-repeat;${p}-position:center`).join(';');
export const BASE_CSS = [
  `${CELL}{position:relative}`,
  `${CELL}::before{content:"";position:absolute;left:1px;top:3px;width:14px;height:14px;pointer-events:none;background:var(--dsm-color,transparent);${MASK};-webkit-mask-composite:source-in;mask-composite:intersect}`,
  `${CELL}:has(${DOT}){--dsm-cut:4px}`,
  `${CELL}:has(${MARK}){--dsm-cut:5px}`,
  `${CELL}:has(${SPIN}){--dsm-cut:5.5px}`,
  // Transforms leave the host's own sizing alone; without a badge variable they resolve to none.
  `${CELL}>${holding(DOT)}{transform:var(--dsm-dot,none)}`,
  `${CELL}>${holding(SPIN)}{transform:var(--dsm-spin,none)}`,
  `${CELL}>${holding(MARK)}{transform:var(--dsm-mark,none)}`,
  '.dsm-hover{display:flex;align-items:center;gap:8px;min-width:0;color:#cfd3d6;font-size:12px;line-height:20px}',
  '.dsm-hover-icon{width:14px;height:14px;flex:none;background:var(--dsm-hover-color);-webkit-mask:var(--dsm-icon) center/contain no-repeat;mask:var(--dsm-icon) center/contain no-repeat}',
  '.dsm-hover-model{overflow-wrap:anywhere}',
  '.dsm-hover-cli{color:#adb2b8;white-space:nowrap}',
].join('\n');
// Status marks are centered at (8,10); the badge centers at (13.5,15.5). A state dot paints a 6px core in a 10px box.
const BADGE = '--dsm-dot:translate(5.5px,5.5px) scale(.85);--dsm-spin:translate(5.5px,5.5px) scale(.72);--dsm-mark:translate(5.5px,5.5px) scale(.6)';

/** Archived rows keep their leading cell blank in the host, so they are left alone. */
const rowSelector = (id: string) => `[data-row-key="session:${id}"]:not([aria-description])>span:first-child`;

export function buildCss(badges: ReadonlyMap<string, ModelBadge>): string {
  const groups = new Map<BrandId, string[]>();
  for (const [id, { brand }] of badges) {
    if (!SAFE_ID.test(id)) continue;
    const rows = groups.get(brand) ?? [];
    rows.push(rowSelector(id)); groups.set(brand, rows);
  }
  if (!groups.size) return BASE_CSS;
  // The host's tertiary spinner fades out at badge size; badged rows draw it in the label color.
  const spinners = [...groups.values()].flat().map(row => `${row} ${SPIN}`).join(',');
  return [BASE_CSS, ...[...groups].map(([brand, rows]) =>
    `${rows.join(',')}{--dsm-icon:${iconUrl(brand)};--dsm-color:${BRAND_COLORS[brand] ?? MONO};${BADGE}}`),
  `${spinners}{color:${MONO}}`].join('\n');
}

/** The selection the session will use next, which is what DSH's model picker shows for it. */
export function badgesOf(list: SessionList | undefined): Map<string, ModelBadge> {
  const badges = new Map<string, ModelBadge>();
  for (const [id, projection] of Object.entries(list?.projectionsBySession ?? {})) {
    const selection = projection.values?.modelSelection;
    const current = selection?.next ?? selection?.lastUsed;
    if (current) badges.set(id, describeSelection(current));
  }
  return badges;
}
const sameBadges = (a: ReadonlyMap<string, ModelBadge>, b: ReadonlyMap<string, ModelBadge>) => a.size === b.size
  && [...a].every(([id, x]) => { const y = b.get(id); return !!y && y.brand === x.brand && y.model === x.model && y.cli === x.cli; });

export interface Overlay {
  badge(sessionId: string): ModelBadge | undefined;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/**
 * Keep the stylesheet in step with the session list. The list carries model selections for attached
 * sessions; rows the user can see but whose sessions were never opened get one projection read each,
 * which DSH serves without opening the conversation.
 */
export function installOverlay(doc: Document, sessions: Sessions, { concurrency = 2, scanDelay = 150 } = {}): Overlay {
  const style = doc.createElement('style');
  style.id = STYLE_ID; style.textContent = BASE_CSS; doc.head.append(style);
  let badges = new Map<string, ModelBadge>(), disposed = false, scanTimer: ReturnType<typeof setTimeout> | undefined, active = 0;
  const listeners = new Set<() => void>(), queue: string[] = [], queued = new Set<string>();

  const pump = () => {
    while (!disposed && active < concurrency && queue.length) {
      const id = queue.shift()!; active++;
      sessions.refreshProjections(id).catch(() => {}).finally(() => { active--; queued.delete(id); pump(); });
    }
  };
  const scan = () => {
    scanTimer = undefined;
    if (disposed) return;
    const projections = sessions.list.getSnapshot()?.projectionsBySession ?? {};
    for (const element of Array.from(doc.querySelectorAll(ROW))) {
      const id = element.getAttribute('data-row-key')!.slice('session:'.length);
      if (!SAFE_ID.test(id) || badges.has(id) || queued.has(id)) continue;
      // Only an unread projection is worth a request; ready, failed and migration-blocked reads are final.
      const state = projections[id]?.state;
      if (state !== undefined && state !== 'idle') continue;
      queued.add(id); queue.push(id);
    }
    pump();
  };
  const scheduleScan = () => { if (!disposed && scanTimer === undefined) scanTimer = setTimeout(scan, scanDelay); };
  const update = () => {
    const next = badgesOf(sessions.list.getSnapshot());
    if (!sameBadges(next, badges)) {
      badges = next; style.textContent = buildCss(next);
      for (const listener of listeners) listener();
    }
    scheduleScan();
  };

  const observer = new (doc.defaultView ?? globalThis).MutationObserver(scheduleScan);
  observer.observe(doc.body, { childList: true, subtree: true });
  const unsubscribe = sessions.list.subscribe(update);
  update();
  return {
    badge: id => badges.get(id),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      disposed = true; observer.disconnect(); unsubscribe(); clearTimeout(scanTimer);
      style.remove(); listeners.clear(); queue.length = 0;
    },
  };
}
