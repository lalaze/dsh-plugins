/** Pieces both conversation screens share: bottom-pinned scrolling, older pages on scroll, and connection notices. */
import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { icons } from './controls.js'
import type { ConnectionState } from './hub-client.js'
import { ui } from './i18n.js'

/**
 * Keep a conversation at its end while it is there: as messages arrive, images load, or the keyboard shrinks the
 * view. Older pages added on top keep what is on screen in place.
 */
export function useChatScroll(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, latest: number) {
  const stick = useRef(true)
  const anchor = useRef<{ height: number; top: number } | undefined>(undefined)
  const [atEnd, setAtEnd] = useState(true)
  const [fresh, setFresh] = useState(false)
  const lastLatest = useRef(latest)

  const toEnd = useCallback((smooth = false) => {
    const element = scroller.current
    if (!element) return
    stick.current = true; setAtEnd(true); setFresh(false)
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [scroller])

  useEffect(() => {
    const element = scroller.current, inner = content.current
    if (!element || !inner) return
    const observer = new ResizeObserver(() => {
      const height = element.scrollHeight
      if (anchor.current) {
        element.scrollTop = anchor.current.top + (height - anchor.current.height)
        anchor.current = undefined
      } else if (stick.current) element.scrollTop = height
    })
    observer.observe(element); observer.observe(inner)
    return () => observer.disconnect()
  }, [scroller, content])

  // Messages that arrive while the reader is further up mark the jump button; older pages loaded on top do not.
  useEffect(() => {
    if (latest > lastLatest.current && !stick.current) setFresh(true)
    lastLatest.current = latest
  }, [latest])

  const onScroll = useCallback(() => {
    const element = scroller.current
    if (!element) return
    const end = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    stick.current = end
    setAtEnd(end)
    if (end) setFresh(false)
  }, [scroller])

  /** Call right before older content is added on top. */
  const holdPosition = useCallback(() => {
    const element = scroller.current
    if (element) anchor.current = { height: element.scrollHeight, top: element.scrollTop }
  }, [scroller])

  return { atEnd, fresh, toEnd, onScroll, holdPosition, stick }
}

/** A button to return to the newest message, with a dot when something new arrived below. */
export function JumpToEnd({ visible, fresh, onClick }: { visible: boolean; fresh: boolean; onClick(): void }) {
  if (!visible) return null
  return <button type="button" className="jump-end" aria-label={ui('Jump to latest')} onClick={onClick}>{icons.arrowDown}{fresh && <span className="jump-dot" />}</button>
}

/** Loads the previous page when the top of the conversation scrolls into view. */
export function LoadEarlier({ root, more, onLoad }: { root: RefObject<HTMLDivElement | null>; more: boolean; onLoad(): Promise<void> }) {
  const marker = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const load = useCallback(async () => {
    if (busy.current) return
    busy.current = true; setLoading(true)
    try { await onLoad() } finally { busy.current = false; setLoading(false) }
  }, [onLoad])
  useEffect(() => {
    if (!more || !marker.current || !root.current) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load() }, { root: root.current, rootMargin: '400px 0px 0px 0px' })
    observer.observe(marker.current)
    return () => observer.disconnect()
  }, [more, load, root])
  if (!more) return null
  return <div ref={marker} className="load-earlier">{loading ? <span className="spinner" /> : <button type="button" className="link" onClick={() => void load()}>{ui('Load earlier')}</button>}</div>
}

/** Says when the computer cannot be reached, and lets the phone try again at once. */
export function OfflineBanner({ state, error, name, onRetry }: { state: ConnectionState; error?: string; name: string; onRetry(): void }) {
  if (state === 'online') return null
  const connecting = state === 'connecting'
  return <div className="banner" data-state={state} role="status">
    {connecting ? <span className="spinner small" /> : icons.offline}
    <span className="banner-text ellipsis">{connecting ? ui('Connecting to {0}…', { 0: name }) : `${name} · ${ui(error ?? 'Offline')}`}</span>
    {!connecting && <button type="button" className="banner-action" onClick={onRetry}>{ui('Retry')}</button>}
  </div>
}

/** An error over the composer that can be dismissed, and goes away by itself after a while. */
export function Toast({ message, onClose }: { message?: string; onClose(): void }) {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onClose, 8000)
    return () => clearTimeout(timer)
  }, [message, onClose])
  if (!message) return null
  return <div className="toast" role="alert"><span>{message}</span><button type="button" aria-label={ui('Close')} onClick={onClose}>{icons.close}</button></div>
}

/** Placeholder lines while a conversation loads. */
export function Skeleton() {
  return <div className="skeleton" aria-label={ui('Connecting…')}>
    <div className="sk sk-user" /><div className="sk sk-line" /><div className="sk sk-line short" /><div className="sk sk-tool" /><div className="sk sk-line" /><div className="sk sk-line shorter" />
  </div>
}
