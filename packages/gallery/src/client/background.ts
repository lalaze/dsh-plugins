import { currentWallpaper } from '../domain.js';
import type { GalleryController } from './controller.js';

// Use DSH's public slot markers and shell attributes, independent of CSS module hashes.
export const backgroundStyles = `
body[data-dsh-gallery-active]{isolation:isolate}
[data-dsh-gallery-background]{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background:var(--dsw-alias-bg-base,Canvas)}
[data-dsh-gallery-background] img{width:100%;height:100%;object-fit:cover;object-position:center;transform:scale(1.06)}
body[data-dsh-gallery-active] #root,
body[data-dsh-gallery-active] [data-slot="root"],
body[data-dsh-gallery-active] #root div:has(>[data-shell-overlay]),
body[data-dsh-gallery-active] #root div:has(>[data-shell-overlay])>:not([data-shell-overlay],[data-shell-leading]),
body[data-dsh-gallery-active] [data-slot="main"],
body[data-dsh-gallery-active] [data-slot="main"]>[data-phase],
body[data-dsh-gallery-active] [data-slot="main.conversation"]>[data-phase]{background:transparent!important}
body[data-dsh-gallery-active] [data-slot="sidebar"]>*{background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,Canvas) 55%,transparent)!important}
`;

export function installBackground(controller: GalleryController): () => void {
  const style = document.createElement('style'); style.dataset.dshGalleryStyle = ''; style.textContent = backgroundStyles;
  document.head.append(style);
  const layer = document.createElement('div'); layer.dataset.dshGalleryBackground = ''; layer.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img'); image.alt = ''; layer.append(image);
  let currentId: string | undefined; let failedId: string | undefined; let objectUrl: string | undefined; let generation = 0; let disposed = false;
  const clear = () => {
    layer.remove(); document.body.removeAttribute('data-dsh-gallery-active'); image.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined; currentId = undefined; failedId = undefined;
  };
  const render = async () => {
    const token = ++generation; const snapshot = controller.getSnapshot();
    const entry = currentWallpaper(snapshot);
    image.style.opacity = String(snapshot.preferences.opacity);
    image.style.filter = `blur(${snapshot.preferences.blur}px)`;
    if (!snapshot.preferences.enabled || !entry) { clear(); return; }
    if (entry.id === currentId) return;
    if (entry.id === failedId && snapshot.error) return;
    let nextUrl: string | undefined;
    try {
      const blob = await controller.storage.image(entry.id);
      if (!blob) throw new Error("The local wallpaper file is missing. Refresh or upload it again");
      nextUrl = URL.createObjectURL(blob);
      const preload = new Image(); preload.src = nextUrl; await preload.decode();
      if (token !== generation || disposed) { URL.revokeObjectURL(nextUrl); return; }
      const previous = objectUrl;
      image.src = nextUrl; objectUrl = nextUrl; currentId = entry.id; failedId = undefined;
      document.body.prepend(layer); document.body.setAttribute('data-dsh-gallery-active', '');
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      if (nextUrl) URL.revokeObjectURL(nextUrl);
      if (token === generation && !disposed) {
        // Do not report recursively on every subsequent store notification.
        failedId = entry.id;
        controller.reportError(error);
      }
    }
  };
  const unsubscribe = controller.subscribe(() => { void render(); }); void render();
  return () => { disposed = true; generation++; unsubscribe(); clear(); style.remove(); };
}
