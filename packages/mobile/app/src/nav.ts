/**
 * Hash routes and overlays. Each open overlay (a bottom sheet, the image viewer) owns one history entry on top of its
 * screen's, so the phone's back gesture closes it instead of leaving the screen. Navigating while overlays are open
 * replaces their entries, so back from the next screen returns to the screen, not to a closed sheet.
 */

interface Overlay { id: number; close(): void }

/** Open overlays, bottom first. */
const stack: Overlay[] = []
/** Overlay IDs that have a history entry above the screen's, bottom first. */
const entries: number[] = []
let counter = 0
/** An overlay closed in this task whose entry is still current; a sheet opened right after takes the entry over. */
let released: number | undefined
let direction: 'forward' | 'back' | 'none' = 'none'

const overlayOf = (state: unknown) => (state as { overlay?: number } | null)?.overlay

// Registered before the app's own listener, so overlays close before the route is read again.
if (typeof window !== 'undefined') {
  addEventListener('popstate', () => {
    const at = entries.indexOf(overlayOf(history.state) ?? -1)
    entries.length = at + 1
    const keep = new Set(entries)
    direction = 'back'
    for (let index = stack.length - 1; index >= 0; index--) {
      if (keep.has(stack[index].id)) continue
      const [overlay] = stack.splice(index, 1)
      overlay.close()
    }
  })
}

/** Show an overlay; the returned function forgets it again once the UI closed it. */
export function openOverlay(close: () => void): () => void {
  const id = ++counter
  if (released !== undefined && entries.at(-1) === released && overlayOf(history.state) === released) {
    history.replaceState({ ...history.state, overlay: id }, '')
    entries[entries.length - 1] = id
  } else {
    history.pushState({ ...history.state, overlay: id }, '')
    entries.push(id)
  }
  released = undefined
  stack.push({ id, close })
  return () => {
    const index = stack.findIndex(overlay => overlay.id === id)
    if (index < 0) return
    stack.splice(index, 1)
    if (entries.at(-1) !== id || overlayOf(history.state) !== id) return
    released = id
    queueMicrotask(() => {
      if (released !== id) return
      released = undefined
      entries.pop()
      history.back()
    })
  }
}

/** Go to a route, replacing the entries of open overlays. */
export function go(path: string, replace = false) {
  const hash = `#/${path}`
  direction = replace ? 'back' : 'forward'
  if (replace && entries.length > 0) {
    // Replacing the screen itself: step back past the overlays' entries first.
    const depth = entries.length
    entries.length = 0
    released = undefined
    addEventListener('popstate', () => { history.replaceState(null, '', hash); dispatchEvent(new HashChangeEvent('hashchange')) }, { once: true })
    history.go(-depth)
    return
  }
  if (entries.length > 0 && overlayOf(history.state) === entries.at(-1)) {
    history.replaceState(null, '', hash)
    entries.length = 0
    released = undefined
  } else if (replace) history.replaceState(null, '', hash)
  else history.pushState(null, '', hash)
  dispatchEvent(new HashChangeEvent('hashchange'))
}

/** Leave the current screen, past the entries of any overlays still open. */
export function back() {
  direction = 'back'
  const depth = entries.length
  entries.length = 0
  released = undefined
  if (history.length > 1 + depth) history.go(-(1 + depth))
  else go('', true)
}

/** Whether the last route change went deeper or came back, for the screen's entrance animation. */
export const navDirection = () => direction

/** Scroll positions and other per-screen view state that outlive the screen while another one is shown. */
export const memory = new Map<string, unknown>()
