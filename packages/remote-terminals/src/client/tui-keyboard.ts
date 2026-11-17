import { useEffect } from 'react';

/** The part of the page on screen, as `window.visualViewport` reports it. */
export interface VisibleViewport extends EventTarget { readonly height: number; readonly offsetTop: number }

/**
 * How much of an element's bottom lies below the part of the page on screen, which is what a phone's keyboard covers.
 * @param bottom - the element's bottom edge, as `getBoundingClientRect` gives it.
 */
export function coveredBottom(bottom: number, viewport: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(bottom - viewport.offsetTop - viewport.height));
}

/**
 * Keeps a TUI above a phone's keyboard. A phone's browser shrinks only the part of the page on screen when its keyboard
 * opens, and then scrolls the whole page up to bring the terminal's input into view: the conversation's header leaves the
 * screen, the page jumps as the cursor moves, and the page can stay scrolled with blank space under it once the keyboard
 * has gone. So while a TUI is shown on a touch screen the page stays where it is, and the TUI shrinks to what is on screen
 * instead: the terminal takes fewer rows, as a terminal app does, and the CLI's prompt sits just above the keyboard.
 * Only the height changes, which the CLIs redraw without rebuilding their history.
 * @param root - the TUI's conversation area.
 * @param touch - whether this is a touch screen; nothing is done otherwise.
 */
export function useKeyboardFit(root: React.RefObject<HTMLElement | null>, touch: boolean, viewport: VisibleViewport | undefined = typeof window === 'undefined' ? undefined : window.visualViewport ?? undefined): void {
  useEffect(() => {
    const node = root.current;
    if (!touch || !node || !viewport) return;
    let frame = 0;
    const pin = () => { if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0); };
    const fit = () => {
      pin();
      // Measured at its full height, which the layout around it decides.
      node.style.maxHeight = '';
      const covered = coveredBottom(node.getBoundingClientRect().bottom, viewport);
      if (covered) node.style.maxHeight = `calc(100% - ${covered}px)`;
    };
    // A keyboard opens over several frames; the last size is the one that counts.
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    fit();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('scroll', pin, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      window.removeEventListener('scroll', pin);
      node.style.maxHeight = '';
    };
  }, [root, touch, viewport]);
}
