/**
 * The rendered HTML document in its sandboxed frame, with a loading mask.
 *
 * A URL (blob:) frame is drawn by a separate renderer process, so the panel
 * gets frames in between while the page parses and paints: the mask says the
 * page is loading instead of looking broken, and keeps clicks and tab stops
 * off the frame until the document reports it has painted. A srcdoc document
 * commits in the same task and needs no mask.
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitKey } from './locales.js'
import { HTML_READY_MESSAGE } from './html-pack.js'
import { inertAttr } from './inert.js'

/** iframe body for a rendered HTML preview: the two modes cannot be mixed. */
export type HtmlFrameSpec =
  | { readonly kind: 'interactive'; readonly src: string }
  | { readonly kind: 'static'; readonly srcdoc: string }

/** Script permission and framing follow the mode: only the interactive one runs
 * scripts, and only it needs the loading mask. */
function frameProps(frame: HtmlFrameSpec): { readonly sandbox: string; readonly masked: boolean } {
  return frame.kind === 'interactive'
    ? { sandbox: 'allow-scripts', masked: true }
    : { sandbox: '', masked: false }
}

/** Past this a URL frame is still painting, so the mask stops promising fast. */
const HTML_SLOW_MS = 4000
/** How long the mask waits for the page's own paint report after load. */
const HTML_READY_FALLBACK_MS = 1500
/** Hard cap: past this the frame is revealed even if it never reported. */
const HTML_MASK_MAX_MS = 20000
/** How often the mask's elapsed counter ticks. */
const HTML_ELAPSED_TICK_MS = 1000

/**
 * The rendered HTML document, with a mask over the blank frame. A URL (blob:)
 * frame is drawn by its own renderer process, so the panel gets frames in
 * between: the mask says the page is loading instead of looking broken, and it
 * keeps clicks off the frame until the document is ready. A srcdoc document
 * commits in the same task and needs no mask.
 *
 * A page whose own scripts run for a long time (a multi-megabyte report) can
 * hold the frame blank far longer than the panel cares to wait. The mask must
 * not turn that into a dead panel: past the slow threshold it stops taking
 * clicks, says how long the wait has been, and offers to stop the render.
 */
export function HtmlFrame(props: {
  frame: HtmlFrameSpec
  title: string
  t: (key: GitKey, params?: Record<string, string | number>) => string
  /** Unmounts the frame; used by the mask's stop control. */
  onStop?: () => void
}): JSX.Element {
  const { frame, title, t, onStop } = props
  const { sandbox, masked } = frameProps(frame)
  const [phase, setPhase] = useState<'loading' | 'slow' | 'ready'>(masked ? 'loading' : 'ready')
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // Load-event fallback for a page whose CSP blocks the appended report.
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The live region exists before its text does: assistive tech does not
  // announce content that arrives together with the region itself.
  const [spoken, setSpoken] = useState('')
  // Seconds the wait has lasted: a count tells the user the panel is alive,
  // where a bare spinner only tells them it is not. Measured from the moment
  // the mask went up, so entering the slow state does not restart the count.
  const [elapsed, setElapsed] = useState(0)
  const waitStartRef = useRef<number | null>(null)
  const finish = useCallback(() => {
    if (settleRef.current !== null) { clearTimeout(settleRef.current); settleRef.current = null }
    setPhase('ready')
  }, [])
  useEffect(() => {
    if (!masked) return
    const id = setTimeout(() => setPhase((prev) => (prev === 'ready' ? prev : 'slow')), HTML_SLOW_MS)
    // A page that never fires `load` (a hung subresource, a script spinning in
    // its own renderer) must not keep the content covered forever: past this
    // the frame is shown as-is, spinner and all.
    const cap = setTimeout(finish, HTML_MASK_MAX_MS)
    return () => { clearTimeout(id); clearTimeout(cap) }
  }, [masked, finish])
  // The elapsed counter runs while the mask is up and counts from the start of
  // the wait, not from the start of the current phase.
  useEffect(() => {
    if (!masked) { waitStartRef.current = null; return }
    if (waitStartRef.current === null) waitStartRef.current = Date.now()
    const started = waitStartRef.current
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), HTML_ELAPSED_TICK_MS)
    return () => clearInterval(id)
  }, [masked])
  useEffect(() => {
    if (!masked || phase === 'ready') { setSpoken(''); return }
    const text = t(phase === 'slow' ? 'files.htmlRenderingSlow' : 'files.htmlRendering')
    const id = requestAnimationFrame(() => setSpoken(text))
    return () => cancelAnimationFrame(id)
  }, [masked, phase, t])
  // The page reports the paint itself: its load handler can keep its renderer
  // busy long after the frame's load event, which would lift the mask on a
  // still-blank frame. Only the frame's own window is trusted.
  useEffect(() => {
    if (!masked) return
    const onMessage = (event: MessageEvent): void => {
      const win = frameRef.current?.contentWindow
      if (win === null || win === undefined || event.source !== win) return
      if (event.data === HTML_READY_MESSAGE) finish()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [masked, finish])
  useEffect(() => () => { if (settleRef.current !== null) clearTimeout(settleRef.current) }, [])
  const onLoad = useCallback(() => {
    if (settleRef.current !== null) clearTimeout(settleRef.current)
    settleRef.current = setTimeout(finish, HTML_READY_FALLBACK_MS)
  }, [finish])
  return h('div', { className: 'gp-files__html-stage' }, [
    // Every preview runs in a locked-down iframe without allow-same-origin, so
    // the document is a unique opaque origin that cannot reach the DSH parent,
    // its storage, or same-origin network.
    h('iframe', {
      key: 'frame', ref: frameRef, className: 'gp-files__html', title,
      sandbox, ...(frame.kind === 'interactive' ? { src: frame.src } : { srcDoc: frame.srcdoc }), referrerPolicy: 'no-referrer',
      // Until the page reports a paint there is nothing to interact with: the
      // mask blocks the pointer and this keeps Tab out of the frame. Once the
      // page is known to be slow the mask stops blocking, so the panel stays
      // usable while the page finishes.
      ...(masked ? { onLoad, ...inertAttr(phase !== 'ready') } : {}),
    }),
    // Stays mounted after load so the exit fades instead of flashing the frame
    // white; click-through and hidden from assistive tech once it is done.
    masked
      ? h('div', {
        key: 'mask', className: 'gp-files__html-mask', 'data-state': phase,
        ...(phase === 'ready' ? { 'aria-hidden': 'true' } : {}),
      }, [
        h('span', { key: 'spin', className: 'gp-files__html-mask-spin' }, h(StateDot, { state: 'ongoing', size: 20 })),
        h('span', { key: 'label', className: 'gp-files__html-mask-label', role: 'status' }, spoken),
        // The wait counter: it shows the panel is working, not stuck.
        phase === 'slow'
          ? h('span', { key: 'elapsed', className: 'gp-files__html-mask-elapsed' }, t('files.htmlRenderingSeconds', { seconds: elapsed }))
          : null,
        // Past the slow threshold the mask no longer takes clicks, so the only
        // thing left to offer is a way out of the wait.
        phase === 'slow' && onStop !== undefined
          ? h('button', {
            key: 'stop', type: 'button', className: 'gp-files__html-mask-stop',
            onClick: onStop,
          }, t('files.htmlStopRendering'))
          : null,
      ])
      : null,
  ])
}
