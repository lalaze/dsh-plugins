import { currentWallpaper } from '../domain.js';
import type { GalleryController } from './controller.js';

const PLUGIN_BAR_SEEN = 'dsh-gallery-plugin-bar';

// Use DSH's public slot markers and shell attributes, independent of CSS module hashes.
// The plugin page header (DSH 0.2.2) paints a solid strip so scrolled content cannot show through it.
// Any tint reads as a band over the wallpaper, so it draws the same wallpaper instead, aligned with the real one.
// The strip is only cleared while that copy is present, so a missing one falls back to DSH's strip, never to overlapping text.
// The automation page paints its own solid page, and its detail panel solid strips, none of them overlapping anything.
export const backgroundStyles = `
body[data-dsh-gallery-active]{isolation:isolate}
[data-dsh-gallery-background]{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;background:var(--dsw-alias-bg-base,Canvas)}
[data-dsh-gallery-background] img,[data-dsh-gallery-mirror] img{width:100%;height:100%;object-fit:cover;object-position:center;transform:scale(1.06)}
body[data-dsh-gallery-active] #root,
body[data-dsh-gallery-active] [data-slot="root"],
body[data-dsh-gallery-active] #root div:has(>[data-shell-overlay]),
body[data-dsh-gallery-active] #root div:has(>[data-shell-overlay])>:not([data-shell-overlay],[data-shell-leading]),
body[data-dsh-gallery-active] [data-slot="main"],
body[data-dsh-gallery-active] [data-slot="main"]>[data-phase],
body[data-dsh-gallery-active] [data-slot="main.conversation"]>[data-phase]{background:transparent!important}
body[data-dsh-gallery-active] [data-slot="sidebar"]>*{background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,Canvas) 55%,transparent)!important}
body[data-dsh-gallery-active] [data-plugin-bar][data-natural]{animation:${PLUGIN_BAR_SEEN} 1ms}
@keyframes ${PLUGIN_BAR_SEEN}{from{--dsh-gallery-seen:1}}
body[data-dsh-gallery-active] [data-plugin-bar][data-natural]:has(>[data-dsh-gallery-mirror])::before{background:transparent!important}
body[data-dsh-gallery-active] [data-plugin-bar][data-natural]:has(>[data-dsh-gallery-mirror])::after{border-color:transparent!important}
[data-dsh-gallery-mirror]{position:absolute;inset:0 0 auto;z-index:-1;height:var(--plugin-header-paint-height,var(--plugin-header-rest-height));overflow:hidden;pointer-events:none;mask-image:linear-gradient(#000 calc(100% - 12px),transparent)}
[data-dsh-gallery-mirror]>div{position:absolute;overflow:hidden;background:var(--dsw-alias-bg-base,Canvas)}
body[data-dsh-gallery-active] [data-testid="task-manager-page"],
body[data-dsh-gallery-active] [data-testid="task-manager-page"] aside :is([class*="_saveFooter"],[class*="_saveFailure"],[class*="_detailNotice"]){background:transparent!important}
body[data-dsh-gallery-active] [data-testid="task-manager-page"] aside{background:color-mix(in srgb,var(--dsw-alias-bg-base,Canvas) 55%,transparent)!important}
`;

export function installBackground(controller: GalleryController): () => void {
  const style = document.createElement('style'); style.dataset.dshGalleryStyle = ''; style.textContent = backgroundStyles;
  document.head.append(style);
  const layer = document.createElement('div'); layer.dataset.dshGalleryBackground = ''; layer.setAttribute('aria-hidden', 'true');
  const image = document.createElement('img'); image.alt = ''; layer.append(image);
  const mirror = document.createElement('div'); mirror.dataset.dshGalleryMirror = ''; mirror.setAttribute('aria-hidden', 'true');
  const mirrorLayer = document.createElement('div'); const mirrorImage = document.createElement('img'); mirrorImage.alt = '';
  mirrorLayer.append(mirrorImage); mirror.append(mirrorLayer);
  // The header is a size container, which may contain `position: fixed`, so the mirror is placed by measuring the real layer.
  const align = () => {
    if (!mirror.parentElement) return;
    const page = layer.getBoundingClientRect(); const own = mirror.parentElement.getBoundingClientRect();
    Object.assign(mirrorLayer.style, { left: `${page.left - own.left}px`, top: `${page.top - own.top}px`, width: `${page.width}px`, height: `${page.height}px` });
  };
  const aligner = new ResizeObserver(align);
  // The animation starts when the header appears, which costs nothing while it is absent, unlike watching the whole page.
  const onAnimationStart = (event: AnimationEvent) => {
    if (event.animationName !== PLUGIN_BAR_SEEN || !(event.target instanceof HTMLElement)) return;
    event.target.append(mirror); aligner.disconnect(); aligner.observe(event.target); aligner.observe(layer); align();
  };
  document.addEventListener('animationstart', onAnimationStart);
  let currentId: string | undefined; let failedId: string | undefined; let objectUrl: string | undefined; let generation = 0; let disposed = false;
  const clear = () => {
    layer.remove(); document.body.removeAttribute('data-dsh-gallery-active'); image.removeAttribute('src');
    aligner.disconnect(); mirror.remove(); mirrorImage.removeAttribute('src');
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined; currentId = undefined; failedId = undefined;
  };
  const render = async () => {
    const token = ++generation; const snapshot = controller.getSnapshot();
    const entry = currentWallpaper(snapshot);
    for (const target of [image, mirrorImage]) {
      target.style.opacity = String(snapshot.preferences.opacity);
      target.style.filter = `blur(${snapshot.preferences.blur}px)`;
    }
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
      image.src = nextUrl; mirrorImage.src = nextUrl; objectUrl = nextUrl; currentId = entry.id; failedId = undefined;
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
  return () => { disposed = true; generation++; unsubscribe(); document.removeEventListener('animationstart', onAnimationStart); clear(); style.remove(); };
}
