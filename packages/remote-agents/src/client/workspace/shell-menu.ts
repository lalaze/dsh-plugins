import { TERMINAL_LAUNCHER } from '../../workspace/domain.js';

// DSH's New terminal shell menu ends at its chevron and spreads left over the card's icon and text.
// Recognized by its chevron in the guide card, or else by the Remote workspace item, it opens below the chevron instead;
// other DSH menus keep their placement. The chevron matters: the menu first opens with only a loading row.
const MARK = 'data-ra-shell-menu', GAP = 4, MARGIN = 8;
// A stylesheet !important outranks the inline left/top DSH keeps writing, without fighting its renders.
// An opening animation grows from the corner at the trigger, not the one DSH chose for its own placement.
const styles = `[${MARK}]{left:var(--ra-shell-menu-left)!important;top:var(--ra-shell-menu-top)!important;right:auto!important;bottom:auto!important;transform-origin:var(--ra-shell-menu-origin)!important}`;

const isShellMenu = (menu: Element, trigger: Element | undefined) => !!trigger?.closest('[data-sidebar-right-guide-entry]')
  || [...menu.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.trim() === TERMINAL_LAUNCHER);

/** The menu's trigger: the element carrying the anchor name the menu names, else the open menu button. */
function triggerOf(menu: HTMLElement): HTMLElement | undefined {
  const anchor = menu.style.getPropertyValue('--dsh-menu-anchor').trim();
  if (anchor) {
    const pattern = new RegExp(`anchor-name:\\s*${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
    for (const element of document.querySelectorAll<HTMLElement>('[style*="anchor-name"]')) {
      if (element !== menu && pattern.test(element.getAttribute('style') ?? '')) return element;
    }
  }
  return [...document.querySelectorAll<HTMLElement>('[aria-haspopup][aria-expanded="true"]')].find(element => !menu.contains(element));
}

/** Left edge under the trigger, below it unless only the space above fits, kept inside the viewport. */
export function placeShellMenu(menu: HTMLElement, trigger: HTMLElement): void {
  const anchor = trigger.getBoundingClientRect(), own = menu.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - own.width - MARGIN));
  const below = anchor.bottom + GAP, above = anchor.top - GAP - own.height;
  const top = below + own.height > window.innerHeight - MARGIN && above >= MARGIN ? above : below;
  // An absolutely positioned portal measures from the document, a fixed one from the viewport.
  const absolute = getComputedStyle(menu).position === 'absolute';
  menu.style.setProperty('--ra-shell-menu-left', `${left + (absolute ? window.scrollX : 0)}px`);
  menu.style.setProperty('--ra-shell-menu-top', `${top + (absolute ? window.scrollY : 0)}px`);
  menu.style.setProperty('--ra-shell-menu-origin', top < anchor.top ? 'bottom left' : 'top left');
  if (!menu.hasAttribute(MARK)) menu.setAttribute(MARK, '');
}

/** Bounded DOM enhancement of DSH's shell menu: placement only, no React tree edits. */
export function installShellMenu(): () => void {
  if (typeof document === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteShellMenu = ''; style.textContent = styles;
  document.head.append(style);
  const open = new Set<HTMLElement>();
  let frame: number | undefined;
  const update = () => {
    frame = undefined;
    for (const menu of open) if (!menu.isConnected) open.delete(menu);
    for (const menu of document.querySelectorAll<HTMLElement>('[role="menu"][data-menu-material]')) if (!open.has(menu) && isShellMenu(menu, triggerOf(menu))) open.add(menu);
    for (const menu of open) { const trigger = triggerOf(menu); if (trigger) placeShellMenu(menu, trigger); }
  };
  const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
  // A new menu is placed in the observer's microtask, before the browser first paints it where DSH put it.
  const observer = new MutationObserver(() => { if (frame !== undefined) { cancelAnimationFrame(frame); } update(); });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
  schedule();
  return () => {
    observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true);
    for (const menu of open) { menu.removeAttribute(MARK); menu.style.removeProperty('--ra-shell-menu-left'); menu.style.removeProperty('--ra-shell-menu-top'); menu.style.removeProperty('--ra-shell-menu-origin'); }
    style.remove();
  };
}
