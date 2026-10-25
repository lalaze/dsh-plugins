import { currentWallpaper, preferencesFrom, protectedWallpaper, sortWallpapers, type Library, type Preferences, type Wallpaper } from '../domain.js';

export const DATABASE_NAME = 'dsh-gallery';
const META = 'wallpapers'; const IMAGES = 'images'; const SETTINGS = 'settings';
export interface SavedImage { entry: Wallpaper; blob: Blob }
export interface GalleryStorage {
  read(): Promise<Library>;
  image(id: string): Promise<Blob | undefined>;
  archive(images: SavedImage[]): Promise<void>;
  update(patch: Partial<Preferences>): Promise<void>;
  remove(id: string): Promise<void>;
  close(): void;
}
const result = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not read the local gallery"));
});
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error ?? new Error("Could not save the gallery. Check available device storage"));
  tx.onerror = () => {}; // onabort carries the transaction's final error.
});

/** Images and metadata commit together; settings mutations read the latest cross-tab state. */
export class IndexedGalleryStorage implements GalleryStorage {
  private opened?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    return this.opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(META, { keyPath: 'id' });
        request.result.createObjectStore(IMAGES);
        request.result.createObjectStore(SETTINGS);
      };
      request.onerror = () => { this.opened = undefined; reject(request.error ?? new Error("Could not open the local gallery")); };
      request.onblocked = () => { this.opened = undefined; reject(new Error("Close other DSH tabs and try again")); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opened = undefined; };
        resolve(db);
      };
    });
  }
  async read(): Promise<Library> {
    const db = await this.open(); const tx = db.transaction([META, SETTINGS], 'readonly');
    const [entries, preferences] = await Promise.all([
      result<Wallpaper[]>(tx.objectStore(META).getAll()), result(tx.objectStore(SETTINGS).get('preferences')),
    ]);
    return { entries: sortWallpapers(entries), preferences: preferencesFrom(preferences) };
  }
  async image(id: string): Promise<Blob | undefined> {
    const db = await this.open();
    return result<Blob | undefined>(db.transaction(IMAGES, 'readonly').objectStore(IMAGES).get(id));
  }
  async archive(images: SavedImage[]): Promise<void> {
    if (!images.length) return;
    const db = await this.open(); const tx = db.transaction([META, IMAGES], 'readwrite'); const done = completed(tx);
    for (const { entry, blob } of images) { tx.objectStore(META).put(entry); tx.objectStore(IMAGES).put(blob, entry.id); }
    await done;
  }
  async update(patch: Partial<Preferences>): Promise<void> {
    const db = await this.open(); const tx = db.transaction([META, IMAGES, SETTINGS], 'readwrite'); const done = completed(tx);
    try {
      const store = tx.objectStore(SETTINGS);
      const preferences = preferencesFrom(await result(store.get('preferences')));
      const next = preferencesFrom({ ...preferences, ...patch });
      if (next.selectedId !== null && (!await result(tx.objectStore(META).get(next.selectedId)) || !await result(tx.objectStore(IMAGES).get(next.selectedId)))) {
        throw new Error("This image is no longer in the gallery. Refresh and try again");
      }
      store.put(next, 'preferences');
    } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done;
  }
  async remove(id: string): Promise<void> {
    const db = await this.open(); const tx = db.transaction([META, IMAGES, SETTINGS], 'readwrite'); const done = completed(tx);
    try {
      const [entries, settings] = await Promise.all([
        result<Wallpaper[]>(tx.objectStore(META).getAll()), result(tx.objectStore(SETTINGS).get('preferences')),
      ]);
      const library = { entries: sortWallpapers(entries), preferences: preferencesFrom(settings) };
      if (protectedWallpaper(library, id) || currentWallpaper(library)?.id === id) throw new Error("Switch wallpapers before deleting this image");
      tx.objectStore(META).delete(id); tx.objectStore(IMAGES).delete(id);
    } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done;
  }
  close(): void {
    void this.opened?.then(db => db.close(), () => {});
    this.opened = undefined;
  }
}
