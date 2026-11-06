import { ui } from '../i18n.js';

/**
 * Show the CLI's images while its turn runs. DSH resolves an image path only once a message has finished, and until then
 * draws its alt text alone. A remote CLI's whole turn is one message, so every screenshot it reads stays a file name for as
 * long as the turn lasts. The text saved in the conversation stays as it is, so this works just the same after returning
 * to a running conversation or reloading the page, and when the message finishes DSH replaces the alt text, image included.
 */
const ALT = 'span[class*="imageAlt"]';
const IMAGE = 'ra-live-image', BUTTON = `${IMAGE}-button`, PREVIEW = 'ra-live-preview';
/** Only the copies this plugin keeps: anything else in a reply waits for DSH, as it always has. */
const CHAT_IMAGE = /[\\/]chat-images[\\/][0-9a-f]{64}\.[a-z]+$/;
const FIBER_LEVELS = 3;
interface Fiber { memoizedProps?: { destination?: unknown } | null; return?: Fiber | null }

// DSH's rules for a finished image and its preview, so nothing moves or changes when DSH takes over.
export const liveImageStyles = `
span:has(>.${BUTTON}){display:inline-block;max-width:100%;font-size:0;vertical-align:middle}
.${BUTTON}{display:block;max-width:100%;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;cursor:zoom-in}
.${BUTTON}:focus-visible,.${PREVIEW}-close:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}
.${IMAGE}{display:block;width:auto;max-width:min(100%,640px);height:auto;max-height:360px;margin:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);object-fit:contain}
.${PREVIEW}{position:fixed;inset:0;z-index:1000}
.${PREVIEW}-stage{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;display:flex;align-items:center;justify-content:center;padding:40px}
.${PREVIEW}-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.${PREVIEW}-image{position:relative;max-width:min(100%,1600px);max-height:100%;object-fit:contain;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-input-major);border:0;box-shadow:var(--dsw-elevation-prominent)}
.${PREVIEW}-close{position:absolute;top:20px;right:20px;z-index:1;display:grid;place-items:center;width:36px;height:36px;border:.5px solid var(--dsw-alias-border-l2-darkmode-thin);border-radius:999px;corner-shape:round;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);cursor:pointer}
`;
const CLOSE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2.5 2.5L13.5 13.5"/><path d="M13.5 2.5L2.5 13.5"/></svg>';

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

/**
 * DSH's image preview, which it opens only from images it drew itself. It sits outside the conversation, so Escape here
 * closes it without counting towards the double Escape that stops a turn.
 * @returns a function closing it.
 */
function openPreview(src: string, name: string): () => void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const root = document.createElement('div');
  root.className = PREVIEW; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', ui('Image preview'));
  root.innerHTML = `<div class="${PREVIEW}-stage"><div class="${PREVIEW}-mask" aria-hidden="true"></div><img class="${PREVIEW}-image"><button type="button" class="${PREVIEW}-close">${CLOSE_ICON}</button></div>`;
  const image = root.querySelector('img')!, button = root.querySelector('button')!;
  image.alt = name; image.referrerPolicy = 'no-referrer'; image.src = src;
  button.setAttribute('aria-label', ui('Close image preview'));
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab') { event.preventDefault(); button.focus(); }
  };
  const close = () => {
    if (!root.isConnected) return;
    window.removeEventListener('keydown', key, true); root.remove(); focused?.focus();
  };
  window.addEventListener('keydown', key, true);
  root.querySelector(`.${PREVIEW}-mask`)!.addEventListener('mousedown', close);
  button.addEventListener('click', close);
  document.body.append(root); button.focus();
  return close;
}

function show(alt: Element, open: (src: string, name: string) => void): void {
  const path = alt.firstElementChild ? undefined : liveImagePath(alt);
  if (!path) return;
  const name = alt.textContent ?? '', src = new URL(`api/file?path=${encodeURIComponent(path)}`, document.baseURI).href, label = ui('View full image');
  const button = document.createElement('button'), image = document.createElement('img');
  button.type = 'button'; button.className = BUTTON; button.title = label; button.setAttribute('aria-label', name ? `${label}: ${name}` : label);
  button.addEventListener('click', () => open(src, name));
  image.className = IMAGE; image.alt = name; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
  // A copy that cannot be read goes back to its alt text.
  image.addEventListener('error', () => button.remove());
  image.src = src;
  button.append(image);
  // Inside DSH's own element, so it goes when DSH replaces that.
  alt.append(button);
}

export function installLiveImages(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteLiveImages = ''; style.textContent = liveImageStyles;
  document.head.append(style);
  let closePreview = () => {};
  const showAlt = (alt: Element) => show(alt, (src, name) => { closePreview = openPreview(src, name); });
  // This sees every change on the page, terminals included, so it looks only at what was added.
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.matches(ALT)) showAlt(element);
      else if (element.firstElementChild) element.querySelectorAll(ALT).forEach(showAlt);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true });
  document.querySelectorAll(ALT).forEach(showAlt);
  return () => {
    observer.disconnect(); style.remove(); closePreview();
    document.querySelectorAll(`.${BUTTON}`).forEach(button => button.remove());
  };
}
