import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { opErrorText, renderConfirmModal, type OpT } from './ops-modals.js'
import { pushScopeNode, type PullPreview } from './overview-statusbar.js'
import { canPush } from './push-policy.js'
import { queryAs, type GitPanelRemote } from './rpc.js'
import type { GitAction, GitSnapshot } from './types.js'

export interface PushModalProps {
  readonly remote: GitPanelRemote
  readonly sessionId: string
  readonly snapshot: GitSnapshot
  readonly onAction: (action: GitAction) => Promise<{ ok: boolean; error?: string }>
  readonly onClose: () => void
  readonly t: OpT
  /** Keep the opener's push control disabled while the request is in flight. */
  readonly onBusyChange?: (busy: boolean) => void
}

/** Mount only while open; a changed repository/HEAD requires a new confirmation. */
export function PushModal({ remote, sessionId, snapshot, onAction, onClose, t, onBusyChange }: PushModalProps): JSX.Element | null {
  const scope = JSON.stringify([sessionId, snapshot.root, snapshot.branch, snapshot.head])
  const openedScope = useRef(scope)
  const current = useRef({ scope, snapshot })
  current.current = { scope, snapshot }
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const [preview, setPreview] = useState<'loading' | PullPreview | null>('loading')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sameScope = scope === openedScope.current

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!sameScope || !canPush(snapshot)) {
      if (!inFlight.current) onClose()
    }
  }, [sameScope, snapshot, busy, onClose])

  useEffect(() => {
    if (!sameScope) return
    let alive = true
    setPreview('loading')
    void (async () => {
      try {
        const res = await remote.query({ sessionId, query: { kind: 'push-preview' } })
        if (!alive || current.current.scope !== openedScope.current) return
        const pv = queryAs(res, 'push-preview')
        if (pv !== null && pv.hasUpstream) setPreview(pv)
        else {
          setPreview(null)
          setError(res.ok ? t('error.generic') : opErrorText(res.error.code, res.error.message, t))
        }
      } catch (e) {
        if (!alive || current.current.scope !== openedScope.current) return
        setPreview(null)
        setError(e instanceof Error ? e.message : t('error.generic'))
      }
    })()
    return () => { alive = false }
  }, [remote, sessionId, scope, sameScope, t])

  const runPush = async (): Promise<void> => {
    // The ref closes the double-click window before React paints the busy state.
    if (inFlight.current || current.current.scope !== openedScope.current || !canPush(current.current.snapshot)) return
    inFlight.current = true
    setError(null)
    setBusy(true)
    onBusyChange?.(true)
    try {
      const res = await onAction({ kind: 'push' })
      if (!mounted.current) return
      if (res.ok) onClose()
      else if (current.current.scope === openedScope.current) setError(res.error ?? t('error.generic'))
    } catch (e) {
      if (mounted.current && current.current.scope === openedScope.current) setError(e instanceof Error ? e.message : t('error.generic'))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
      onBusyChange?.(false)
    }
  }

  if (!sameScope) return null
  return renderConfirmModal({
    title: t('status.pushConfirmTitle'),
    body: t('status.pushConfirmBody', { branch: snapshot.branch ?? 'HEAD', ahead: snapshot.ahead }),
    extra: preview === null ? null : pushScopeNode(preview, t),
    confirmLabel: t('status.pushConfirm'),
    danger: false,
    error,
    confirmBusy: busy,
    busyLabel: t('status.pushing'),
    onConfirm: () => void runPush(),
    onClose: () => { if (!inFlight.current) onClose() },
    t,
  })
}
