import { useEffect, useRef, useState } from 'react'
import { ATTACHMENT_ROUTE, LIVE_ROUTE, LOCAL_ROUTE, type LiveFrame, type LocalAction, type LocalStatus } from '../shared/protocol.js'
import { localizeError } from './i18n.js'

export async function act<T = unknown>(action: LocalAction): Promise<T> {
  const response = await fetch(LOCAL_ROUTE, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Device-Sync': '1' }, body: JSON.stringify(action),
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

export async function loadStatus(signal?: AbortSignal): Promise<LocalStatus> {
  const response = await fetch(LOCAL_ROUTE, { credentials: 'same-origin', cache: 'no-store', signal })
  const body = await response.json().catch(() => ({})) as LocalStatus & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

/** The host's sync status, refreshed every `intervalMs` while mounted and visible. */
export function useStatus(intervalMs = 2_000): { status?: LocalStatus; error?: string; refresh(): Promise<void> } {
  const [status, setStatus] = useState<LocalStatus>()
  const [error, setError] = useState<string>()
  const generation = useRef(0)
  const refresh = async () => {
    const current = ++generation.current
    try {
      const next = await loadStatus()
      if (current === generation.current) { setStatus(next); setError(undefined) }
    } catch (failure) { if (current === generation.current) setError(localizeError(failure)) }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, intervalMs)
    return () => { clearInterval(timer); generation.current++ }
  }, [intervalMs])
  return { status, error, refresh }
}

export const attachmentUrl = (deviceId: string, sessionId: string, attachmentId: string) =>
  `${ATTACHMENT_ROUTE}?${new URLSearchParams({ device: deviceId, session: sessionId, attachment: attachmentId })}`

/** Follow a mirrored session live until `signal` ends, calling `onFrame` for each frame. Resolves when the stream ends. */
export async function followLive(deviceId: string, sessionId: string, signal: AbortSignal, onFrame: (frame: LiveFrame) => void): Promise<void> {
  const response = await fetch(`${LIVE_ROUTE}?${new URLSearchParams({ device: deviceId, session: sessionId })}`, { credentials: 'same-origin', cache: 'no-store', signal })
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onFrame(JSON.parse(line) as LiveFrame)
    }
  }
}

/** A request ID the executing machine uses to run a request only once. */
export const requestId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`)
