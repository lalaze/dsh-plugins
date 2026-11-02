import { useEffect, useRef, useState } from 'react'
import { LOCAL_ROUTE, type LocalAction, type LocalStatus } from '../shared/protocol.js'
import { localizeError } from './i18n.js'

export async function act<T = unknown>(action: LocalAction): Promise<T> {
  const response = await fetch(LOCAL_ROUTE, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Mobile': '1' }, body: JSON.stringify(action),
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

/** The hub's status, refreshed every `intervalMs` while mounted and visible. */
export function useStatus(intervalMs = 1_500): { status?: LocalStatus; error?: string; refresh(): Promise<void> } {
  const [status, setStatus] = useState<LocalStatus>()
  const [error, setError] = useState<string>()
  const generation = useRef(0)
  const refresh = async () => {
    const current = ++generation.current
    try {
      const response = await fetch(LOCAL_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json().catch(() => ({})) as LocalStatus & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (current === generation.current) { setStatus(body); setError(undefined) }
    } catch (failure) { if (current === generation.current) setError(localizeError(failure)) }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, intervalMs)
    return () => { clearInterval(timer); generation.current++ }
  }, [intervalMs])
  return { status, error, refresh }
}
