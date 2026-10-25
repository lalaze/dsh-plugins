import { MAX_IMAGE_BYTES, isMarket, validateBingId, type Market, type Wallpaper } from './domain.js';

type Fetch = typeof globalThis.fetch;
const BING = 'https://www.bing.com';
export function parseBingFeed(value: unknown, market: Market): Wallpaper[] {
  if (!value || typeof value !== 'object' || !('images' in value) || !Array.isArray(value.images) || !value.images.length || value.images.length > 8) {
    throw new Error("Bing returned an invalid image list");
  }
  const entries = value.images.map((image: unknown): Wallpaper => {
    if (!image || typeof image !== 'object') throw new Error("Invalid Bing image metadata");
    const row = image as Record<string, unknown>;
    if (typeof row.url !== 'string' || typeof row.startdate !== 'string' || !/^\d{8}$/.test(row.startdate)
      || typeof row.title !== 'string' || typeof row.copyright !== 'string' || typeof row.copyrightlink !== 'string') {
      throw new Error("Incomplete Bing image metadata");
    }
    const imageUrl = new URL(row.url, BING);
    const copyrightUrl = new URL(row.copyrightlink);
    if (imageUrl.origin !== BING || imageUrl.pathname !== '/th' || imageUrl.username || imageUrl.password
      || copyrightUrl.origin !== BING || copyrightUrl.username || copyrightUrl.password) throw new Error("Invalid Bing image source");
    return {
      id: validateBingId(imageUrl.searchParams.get('id') ?? ''), source: 'bing', market,
      date: `${row.startdate.slice(0, 4)}-${row.startdate.slice(4, 6)}-${row.startdate.slice(6, 8)}`,
      title: row.title.slice(0, 500) || row.copyright.slice(0, 500), copyright: row.copyright.slice(0, 2000), copyrightUrl: copyrightUrl.href,
    };
  });
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

/** Fixed upstream endpoints only; the route never accepts arbitrary URLs. */
export class BingService {
  private cache = new Map<Market, { at: number; entries: Wallpaper[] }>();
  private pending = new Map<Market, Promise<Wallpaper[]>>();
  constructor(private request: Fetch = globalThis.fetch, private now = Date.now) {}
  async feed(market: string): Promise<Wallpaper[]> {
    if (!isMarket(market)) throw new Error("Unsupported Bing region");
    const cached = this.cache.get(market);
    if (cached && this.now() - cached.at < 60 * 60 * 1000) return cached.entries;
    const pending = this.pending.get(market);
    if (pending) return pending;
    const promise = (async () => {
      const url = new URL('/HPImageArchive.aspx', BING);
      url.search = new URLSearchParams({ format: 'js', idx: '0', n: '8', mkt: market }).toString();
      const response = await this.request(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) throw new Error(`Bing image list request failed (${response.status})`);
      const entries = parseBingFeed(await response.json(), market);
      this.cache.set(market, { entries, at: this.now() });
      return entries;
    })();
    this.pending.set(market, promise);
    try { return await promise; } finally { this.pending.delete(market); }
  }
  async image(id: string): Promise<Uint8Array<ArrayBuffer>> {
    const url = new URL('/th', BING);
    url.searchParams.set('id', validateBingId(id));
    const response = await this.request(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Bing image download failed (${response.status})`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error("Bing image exceeds 10 MB");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new Error("Bing image exceeds 10 MB");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("Bing returned an invalid JPEG image");
    return bytes;
  }
}

export function createGalleryHandler(service = new BingService()) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
    try {
      if (url.pathname === '/api/gallery/bing') {
        const market = url.searchParams.get('market') ?? 'zh-CN';
        if (!isMarket(market)) return Response.json({ error: "Unsupported Bing region" }, { status: 400 });
        return Response.json({ entries: await service.feed(market) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/gallery/image') {
        const id = url.searchParams.get('id') ?? '';
        try { validateBingId(id); } catch { return Response.json({ error: "Invalid Bing image ID" }, { status: 400 }); }
        return new Response(await service.image(id), { headers: {
          'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
        } });
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Could not connect to Bing. Try again later" }, {
        status: 502, headers: { 'Cache-Control': 'no-store' },
      });
    }
  };
}
