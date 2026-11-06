/**
 * Show the CLI's images while its turn runs. DSH resolves an image path only once a message has finished, and until then
 * draws its alt text alone. A remote CLI's whole turn is one message, so every screenshot it reads stays a file name for as
 * long as the turn lasts. The text saved in the conversation stays as it is, so this works just the same after returning
 * to a running conversation or reloading the page, and when the message finishes DSH replaces the alt text, image included.
 */
const ALT = 'span[class*="imageAlt"]';
const IMAGE = 'ra-live-image';
/** Only the copies this plugin keeps: anything else in a reply waits for DSH, as it always has. */
const CHAT_IMAGE = /[\\/]chat-images[\\/][0-9a-f]{64}\.[a-z]+$/;
const FIBER_LEVELS = 3;
interface Fiber { memoizedProps?: { destination?: unknown } | null; return?: Fiber | null }

// DSH's rules for a finished image in a reply, so the image does not move when DSH takes over.
export const liveImageStyles = `
span:has(>.${IMAGE}){display:inline-block;max-width:100%;font-size:0;vertical-align:middle}
.${IMAGE}{display:block;width:auto;max-width:min(100%,640px);height:auto;max-height:360px;margin:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);object-fit:contain}
`;

/**
 * The file an alt text stands for, through what React stores on its element: DSH leaves the path out of the page.
 * @returns undefined for other images, or if DSH came to keep the path elsewhere: then the alt text just stays.
 */
export function liveImagePath(alt: Element): string | undefined {
  const key = Object.keys(alt).find(name => name.startsWith('__reactFiber$'));
  let fiber = key ? (alt as unknown as Record<string, Fiber | null | undefined>)[key]?.return : undefined;
  for (let level = 0; fiber && level < FIBER_LEVELS; level += 1, fiber = fiber.return) {
    const destination = fiber.memoizedProps?.destination;
    if (typeof destination !== 'string') continue;
    try {
      const path = decodeURIComponent(destination);
      return CHAT_IMAGE.test(path) ? path : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function show(alt: Element): void {
  const path = alt.firstElementChild ? undefined : liveImagePath(alt);
  if (!path) return;
  const image = document.createElement('img');
  image.className = IMAGE; image.alt = alt.textContent ?? ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  // A copy that cannot be read goes back to its alt text.
  image.addEventListener('error', () => image.remove());
  image.src = new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI).href;
  // Inside DSH's own element, so it goes when DSH replaces that.
  alt.append(image);
}

export function installLiveImages(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteLiveImages = ''; style.textContent = liveImageStyles;
  document.head.append(style);
  // This sees every change on the page, terminals included, so it looks only at what was added.
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.matches(ALT)) show(element);
      else if (element.firstElementChild) element.querySelectorAll(ALT).forEach(show);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
  document.querySelectorAll(ALT).forEach(show);
  return () => {
    observer.disconnect(); style.remove();
    document.querySelectorAll(`.${IMAGE}`).forEach(image => image.remove());
  };
}
