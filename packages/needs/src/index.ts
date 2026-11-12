/** Build-time shared code: esbuild includes this in each independent plugin archive. */

/** How DSH answers a call from a page. */
export interface RemoteResult<T> { ok: boolean; value?: T; error?: { message?: string } }
interface MarketVersion { version: string; install: { spec: string; registry?: string } }
interface MarketEntry {
  name: string; versions: readonly MarketVersion[];
  /** The newest version this DSH accepts; absent when it accepts none. */
  defaultVersion?: string;
  installation?: { status: 'not-installed' | 'installed' | 'update-available' | 'different-version' | 'provided'; installedVersion?: string };
}
interface MarketPage { entries: readonly MarketEntry[]; nextOffset: number | null }
interface Change { application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'; error?: { code?: string; diagnostic?: string }; pendingBuilds?: string[] }
/** The client's `remote` service, as far as this needs it. A DSH without plugin management has neither namespace. */
export interface Remote {
  pluginMarket?: {
    listIndexes(): Promise<RemoteResult<{ url: string }[]>>;
    search(url: string, query: { text: string; sort: { kind: 'relevance' }; offset: number; limit: number }): Promise<RemoteResult<MarketPage>>;
  };
  pluginManager?: { installBundle(spec: string, options?: { enabled?: boolean; registry?: string }): Promise<RemoteResult<Change>> };
}
/**
 * What can be done about a plugin that is wanted: `install` or `update` it from a market; `present` when the market's
 * newest is what DSH already has, so it is switched off or waits for a restart; `unlisted` when no market of this DSH
 * offers a version it accepts; `unavailable` when this page cannot ask at all.
 */
export type Offer =
  | { kind: 'install' | 'update'; name: string; version: string; spec: string; registry?: string; installed?: string }
  | { kind: 'present'; name: string; installed?: string }
  | { kind: 'unlisted' | 'unavailable'; name: string };
/** `restart`: the files are there and DSH loads them at its next start. */
export type Outcome = { kind: 'applied' | 'restart' } | { kind: 'failed'; detail: string };

const PAGE = 50, PAGES = 4;
/** The market's entry for exactly this package; the search itself is fuzzy. */
async function entryOf(market: NonNullable<Remote['pluginMarket']>, url: string, name: string): Promise<MarketEntry | undefined> {
  for (let offset: number | null = 0, page = 0; offset !== null && page < PAGES; page++) {
    const result: RemoteResult<MarketPage> = await market.search(url, { text: name, sort: { kind: 'relevance' }, offset, limit: PAGE });
    if (!result.ok || !result.value) return undefined;
    const found = result.value.entries.find(entry => entry.name === name);
    if (found) return found;
    offset = result.value.nextOffset;
  }
  return undefined;
}
/** The client's `remote` service from a plugin's context; a namespace the DSH does not have is left out. */
export function remoteFrom(ctx: { get?(name: string): unknown } | undefined): Remote | undefined {
  const part = (name: 'pluginMarket' | 'pluginManager') => {
    try { return (ctx?.get?.(`remote.${name}`) ?? (ctx?.get?.('remote') as Remote | undefined)?.[name]) as never; } catch { return undefined; }
  };
  const pluginMarket = part('pluginMarket') as Remote['pluginMarket'], pluginManager = part('pluginManager') as Remote['pluginManager'];
  return pluginMarket || pluginManager ? { ...(pluginMarket ? { pluginMarket } : {}), ...(pluginManager ? { pluginManager } : {}) } : undefined;
}
export async function offerFor(remote: Remote | undefined, name: string): Promise<Offer> {
  const market = remote?.pluginMarket;
  if (!market || !remote?.pluginManager) return { kind: 'unavailable', name };
  let indexes: RemoteResult<{ url: string }[]>;
  try { indexes = await market.listIndexes(); } catch { return { kind: 'unavailable', name }; }
  if (!indexes.ok || !indexes.value) return { kind: 'unavailable', name };
  let present: Offer | undefined;
  for (const { url } of indexes.value) {
    // One market that does not answer leaves the others to try.
    const entry = await entryOf(market, url, name).catch(() => undefined);
    const version = entry?.versions.find(candidate => candidate.version === entry.defaultVersion);
    if (!entry || !version) continue;
    const status = entry.installation?.status ?? 'not-installed', installed = entry.installation?.installedVersion;
    if (status === 'not-installed' || status === 'update-available') {
      return { kind: status === 'not-installed' ? 'install' : 'update', name, version: version.version, spec: version.install.spec, ...(version.install.registry ? { registry: version.install.registry } : {}), ...(installed ? { installed } : {}) };
    }
    present ??= { kind: 'present', name, ...(installed ? { installed } : {}) };
  }
  return present ?? { kind: 'unlisted', name };
}
export async function install(remote: Remote | undefined, offer: Extract<Offer, { kind: 'install' | 'update' }>): Promise<Outcome> {
  const manager = remote?.pluginManager;
  if (!manager) return { kind: 'failed', detail: 'This DSH has no plugin manager.' };
  let result: RemoteResult<Change>;
  try { result = await manager.installBundle(offer.spec, { enabled: true, ...(offer.registry ? { registry: offer.registry } : {}) }); }
  catch (error) { return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }; }
  if (!result.ok || !result.value) return { kind: 'failed', detail: result.error?.message ?? 'DSH did not say why.' };
  const change = result.value;
  if (change.application === 'applied') {
    // A plugin that already runs keeps its loaded code until DSH starts again, whatever the manager reports.
    return { kind: offer.kind === 'update' ? 'restart' : 'applied' };
  }
  if (change.application === 'restart-required') return { kind: 'restart' };
  const waiting = change.pendingBuilds?.length ? `Scripts of ${change.pendingBuilds.join(', ')} wait for approval on the Plugins page.` : '';
  return { kind: 'failed', detail: [change.error?.diagnostic ?? change.error?.code ?? change.application, waiting].filter(Boolean).join(' ') };
}
