/**
 * Dismissible notice banner: one informational strip with a close button
 * pinned to its right edge. The host owns visibility (see useDismissedNotices
 * for the "hide until the text changes" case), so every notice can be closed
 * without losing the underlying state.
 */
import { createElement as h, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { CloseIcon } from './icons.js'

interface NoticeBarProps {
  readonly text: string
  /** Localized accessible name for the close button. */
  readonly closeLabel: string
  readonly onClose: () => void
  /** Announce once when the banner appears after a poll (role="status"). */
  readonly status?: boolean
}

export function NoticeBar({ text, closeLabel, onClose, status = false }: NoticeBarProps): JSX.Element {
  return h('div', { className: 'gp-notice', ...(status ? { role: 'status' } : {}) }, [
    h('span', { key: 'txt', className: 'gp-notice__text' }, text),
    h('button', {
      key: 'close', type: 'button', className: 'gp-notice__close',
      title: closeLabel, 'aria-label': closeLabel, onClick: onClose,
    }, h(CloseIcon, { key: 'i', size: 12 })),
  ])
}

/**
 * Per-host dismissal state for snapshot-derived notices: a closed notice stays
 * hidden until its text changes (a new count or reason), so a persistent
 * condition is not re-announced right after the user dismissed it.
 */
export function useDismissedNotices(): {
  isDismissed: (text: string) => boolean
  dismiss: (text: string) => void
} {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  return useMemo(() => ({
    isDismissed: (text: string) => dismissed.has(text),
    dismiss: (text: string) => setDismissed((prev) => (prev.has(text) ? prev : new Set(prev).add(text))),
  }), [dismissed])
}
