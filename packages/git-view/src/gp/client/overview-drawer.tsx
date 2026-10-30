/**
 * The branch-list drawer shared by the tight stacked sidebar and a phone's
 * compact overview: a backdrop (a tap on the blank area dismisses) plus the
 * sliding column. It takes the dialog contract its look implies — `role`,
 * `aria-modal`, a labelled title, and Tab contained inside it through the
 * shared `useDialogFocus`. Escape stays out of that hook: it is a capture
 * listener, and the drawer sits *below* the dialogs it can be opened over, so
 * the keystroke is left to them (`escape: false`) and the drawer only claims it
 * when nothing is mounted above (`hasOverlay`).
 * z-index and the slide live in css/stacked.ts; `className` lets the stacked
 * host keep its band-column sizing (`gp-col--left`) while compact mounts a
 * plain column. Returns a keyed array so the caller spreads it among the
 * children of its layout root.
 */
import { createElement as h } from 'react'
import type { JSX, RefObject } from 'react'
import { CloseIcon } from './icons.js'
import { inertAttr } from './inert.js'
import { useDialogFocus } from './dialog-focus.js'
import type { GitKey } from './locales.js'

export interface BranchDrawerArgs {
  readonly open: boolean
  /** The drawer element id, also the target of the toolbar toggle's aria-controls. */
  readonly id: string
  readonly className: string
  readonly rootRef: RefObject<HTMLDivElement | null>
  readonly closeRef: RefObject<HTMLButtonElement | null>
  readonly toggleRef: RefObject<HTMLButtonElement | null>
  readonly onClose: () => void
  readonly children: readonly JSX.Element[]
  readonly t: (key: GitKey, params?: Record<string, string | number>) => string
}

export function renderBranchDrawer(a: BranchDrawerArgs): JSX.Element[] {
  // The title id derives from the drawer id, so both survive a re-render without
  // a second hook in a plain render function.
  const titleId = `${a.id}-title`
  return [
    ...(a.open ? [h('div', { key: 'backdrop', className: 'gp-drawer-backdrop', onClick: a.onClose })] : []),
    h('div', {
      key: 'drawer', id: a.id, ref: a.rootRef, className: a.className,
      'data-open': a.open ? 'true' : 'false',
      ...(a.open ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId } : {}),
      ...inertAttr(!a.open),
    }, [
      // Renders null: it exists so the shared dialog hook mounts with the open
      // drawer and unmounts with it, restoring focus to the toolbar toggle.
      a.open
        ? h(BranchDrawerFocus, { key: 'focus', rootRef: a.rootRef, closeRef: a.closeRef, toggleRef: a.toggleRef, onClose: a.onClose })
        : null,
      h('div', { key: 'bar', className: 'gp-drawer__bar' }, [
        h('span', { key: 'title', id: titleId, className: 'gp-drawer__title' }, a.t('overview.filterBranch')),
        h('button', {
          key: 'close', type: 'button', ref: a.closeRef, className: 'gp-icon-btn gp-drawer__close',
          title: a.t('common.close'), 'aria-label': a.t('common.close'), onClick: a.onClose,
        }, h(CloseIcon, { size: 14 })),
      ]),
      ...a.children,
    ]),
  ]
}

/** Focus containment for the drawer; its Escape belongs to the layer above. */
function BranchDrawerFocus(props: {
  readonly rootRef: RefObject<HTMLDivElement | null>
  readonly closeRef: RefObject<HTMLButtonElement | null>
  readonly toggleRef: RefObject<HTMLButtonElement | null>
  readonly onClose: () => void
}): null {
  useDialogFocus(props.rootRef, props.onClose, props.closeRef, props.toggleRef, false)
  return null
}
