import { DEFAULT_PREFERENCES, MAX_IMAGE_BYTES, REFRESH_INTERVAL, currentWallpaper, imageMime, type Library, type Preferences, type Wallpaper } from '../domain.js';
import { type GalleryStorage, type SavedImage } from './storage.js';

export interface GallerySnapshot extends Library { loading: boolean; busy: boolean; error: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class GalleryController {
  private snapshot: GallerySnapshot = { entries: [], preferences: { ...DEFAULT_PREFERENCES }, loading: true, busy: false, error: '' };
  private listeners = new Set<() => void>();
  private pendingRefresh?: Promise<void>;
  private abort?: AbortController;
  private running = false;
  private operations = 0;
  constructor(readonly storage: GalleryStorage, private request = globalThis.fetch.bind(globalThis), private now = Date.now) {}
  getSnapshot = (): GallerySnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<GallerySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  async reload(): Promise<void> {
    this.publish({ ...await this.storage.read(), loading: false });
  }
  private changed(): void {
    // Storage events reach other tabs; no image bytes go through localStorage.
    try { localStorage.setItem('dsh-gallery:changed', `${this.now()}:${Math.random()}`); } catch {}
  }
  private async operation(action: () => Promise<void>): Promise<void> {
    this.operations++; this.publish({ busy: true, error: '' });
    try { await action(); await this.reload(); this.changed(); }
    catch (error) {
      this.publish({ error: message(error), loading: false });
      // A successful image archive can precede a failed settings write.
      try { await this.reload(); } catch {}
    } finally { this.operations--; this.publish({ busy: this.operations > 0 }); }
  }
  start(): () => void {
    this.running = true;
    const tick = () => {
      if (!this.running || document.hidden || this.snapshot.loading || !this.snapshot.preferences.enabled) return;
      if (this.now() - this.snapshot.preferences.lastSyncAt >= REFRESH_INTERVAL) void this.refresh();
    };
    void this.reload().then(tick, error => this.publish({ loading: false, error: message(error) }));
    const visible = () => { if (!document.hidden) void this.reload().then(tick, error => this.publish({ error: message(error) })); };
    const otherTab = (event: StorageEvent) => { if (event.key === 'dsh-gallery:changed') visible(); };
    const timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('storage', otherTab);
    return () => {
      this.running = false; this.abort?.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('storage', otherTab);
      this.storage.close();
    };
  }
  refresh = (): Promise<void> => {
    if (this.pendingRefresh) return this.pendingRefresh;
    this.pendingRefresh = this.operation(async () => {
      const market = this.snapshot.preferences.market;
      const controller = new AbortController(); this.abort = controller;
      const response = await this.request(`/api/gallery/bing?market=${market}`, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
      });
      const body = await response.json() as { entries?: Wallpaper[]; error?: string };
      if (!response.ok) throw new Error(body.error || `Gallery request failed (${response.status})`);
      if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 8) throw new Error("The Bing image list is empty. Try again later");
      const queue = [...body.entries]; const saved: SavedImage[] = [];
      // Two downloads at a time; publish the complete batch only after every image is safe locally.
      const worker = async () => {
        while (queue.length) {
          const entry = queue.shift()!;
          const cached = await this.storage.image(entry.id);
          if (cached) { saved.push({ entry, blob: cached }); continue; }
          const image = await this.request(`/api/gallery/image?id=${encodeURIComponent(entry.id)}`, {
            credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
          });
          if (!image.ok) throw new Error(`Image download failed (${image.status}); your previous wallpaper was kept`);
          const blob = await image.blob();
          if (blob.size > MAX_IMAGE_BYTES || imageMime(new Uint8Array(await blob.slice(0, 16).arrayBuffer())) !== 'image/jpeg') throw new Error("The downloaded image is invalid; your previous wallpaper was kept");
          await decodeImage(blob);
          saved.push({ entry, blob });
        }
      };
      try { await Promise.all([worker(), worker()]); }
      catch (error) { controller.abort(); throw error; }
      if (controller.signal.aborted) return;
      await this.storage.archive(saved);
      // A region change during download should request its own fresh feed.
      const latest = await this.storage.read();
      if (latest.preferences.market === market) await this.storage.update({ lastSyncAt: this.now() });
    }).finally(() => { this.pendingRefresh = undefined; this.abort = undefined; });
    return this.pendingRefresh;
  };
  update = (patch: Partial<Preferences>): Promise<void> => this.operation(async () => {
    await this.storage.update(patch);
  });
  enable = async (enabled: boolean): Promise<void> => {
    await this.update({ enabled });
    if (enabled && this.snapshot.preferences.enabled && (!currentWallpaper(this.snapshot) || this.now() - this.snapshot.preferences.lastSyncAt >= REFRESH_INTERVAL)) await this.refresh();
  };
  select = (id: string): Promise<void> => this.update({ selectedId: id, enabled: true });
  resumeDaily = async (): Promise<void> => {
    await this.update({ selectedId: null, enabled: true });
    if (this.now() - this.snapshot.preferences.lastSyncAt >= REFRESH_INTERVAL) await this.refresh();
  };
  changeMarket = async (market: Preferences['market']): Promise<void> => {
    await this.update({ market, lastSyncAt: 0 });
    await this.refresh();
  };
  remove = (id: string): Promise<void> => this.operation(() => this.storage.remove(id));
  upload = (files: File[]): Promise<void> => this.operation(async () => {
    if (files.length > 20) throw new Error("Upload no more than 20 images at a time");
    const images: SavedImage[] = [];
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} exceeds 10 MB`);
      const type = imageMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
      if (!type) throw new Error(`${file.name}: Choose a JPG, PNG or WebP image`);
      const blob = file.slice(0, file.size, type); await decodeImage(blob);
      const random = Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('');
      images.push({ entry: {
        id: `local-${random}`, source: 'local', title: file.name.replace(/\.[^.]+$/, '').slice(0, 200) || "Local image",
        date: new Date(this.now()).toISOString(), copyright: "Local uploads",
      }, blob });
    }
    await this.storage.archive(images);
  });
  reportError = (error: unknown): void => this.publish({ error: message(error) });
}

export async function decodeImage(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url;
    await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error("Image dimensions are too large. Use an image under 40 megapixels");
  } finally { URL.revokeObjectURL(url); }
}
