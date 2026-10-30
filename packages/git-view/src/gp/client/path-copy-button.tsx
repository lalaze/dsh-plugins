/**
 * Click-to-copy path control, shared by the diff pane's header, the commit-diff
 * modal's header and the files toolbar: one shape, so the three bars read and
 * behave alike.
 *
 * The visible path never swaps out for the confirmation (a bare text node wraps
 * when the bar squeezes it below the phrase's width): on success the directory
 * slot trades places with a check mark, on failure only the colour changes —
 * dir/name keep their nowrap/ellipsis either way. The phrase rides `aria-label`,
 * `title` (feedback period only) and a visually-hidden live region.
 */
import { createElement as h } from 'react'
import type { JSX } from 'react'
import type { GitKey } from './locales.js'
import type { CopyFeedback } from './copy-feedback.js'
import { CheckIcon } from './icons.js'

interface PathCopyButtonProps {
  /** Relative path shown and copied. */
  readonly path: string
  /** Outcome of the last write, from `useCopyFeedback`. */
  readonly feedback: CopyFeedback
  readonly onCopy: () => void
  readonly t: (key: GitKey, params?: Record<string, string | number>) => string
  /** Root class; the `--copied` / `--error` modifiers are derived from it. */
  readonly rootClass: string
  readonly dirClass: string
  /** Own element in `split` shape; unused by `attached`. */
  readonly sepClass?: string
  readonly nameClass: string
  /** Extra root classes (the modal header carries its button affordance here). */
  readonly extraClass?: string
  readonly checkSize?: number
  readonly disabled?: boolean
  /** `attached` folds the separator into the directory span (the commit-diff
   * modal's shape: "src/client/" + "app.ts"); `split` renders it as its own
   * element ("src/client" + "/" + "app.ts"). */
  readonly separator?: 'split' | 'attached'
  /** Element key, for callers placing the button in an array. */
  readonly elementKey?: string
}

export function pathCopyButton(props: PathCopyButtonProps): JSX.Element {
  const {
    path, feedback, onCopy, t, rootClass, dirClass, sepClass, nameClass,
    extraClass, checkSize = 11, disabled = false, separator = 'split', elementKey,
  } = props
  const phrase = feedback === 'copied' ? 'files.pathCopied' : feedback === 'error' ? 'files.pathCopyFailed' : 'files.copyPath'
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? null : path.slice(0, slash)
  const name = slash < 0 ? path : path.slice(slash + 1)
  const modifier = feedback === 'copied' ? ` ${rootClass}--copied` : feedback === 'error' ? ` ${rootClass}--error` : ''
  return h('button', {
    ...(elementKey === undefined ? {} : { key: elementKey }),
    type: 'button',
    className: `${rootClass}${extraClass === undefined ? '' : ` ${extraClass}`}${modifier}`,
    disabled,
    title: feedback === 'idle' ? path : `${t(phrase)} ${path}`,
    'aria-label': `${t(phrase)} ${path}`,
    // Never hand the click event to `onCopy`: the shared hook's copy takes an
    // optional text payload, so `onClick: onCopy` would write the event object.
    onClick: () => onCopy(),
  }, [
    feedback === 'copied'
      ? h(CheckIcon, { key: 'ok', size: checkSize })
      : dir === null
        ? null
        : separator === 'attached'
          ? h('span', { key: 'd', className: dirClass }, `${dir}/`)
          : [h('span', { key: 'd', className: dirClass }, dir), h('span', { key: 's', className: sepClass ?? `${rootClass}-sep` }, '/')],
    // The name is always a real element, root-level files included: as a bare
    // text node it lost both the hover underline and any elision, so a long
    // name at the repository root was hard-clipped by the button's overflow
    // while the same name inside a directory elided. `--root` is the shape with
    // no directory before it, which has to shrink (and elide) on its own.
    h('span', { key: 'n', className: dir === null ? `${nameClass} ${nameClass}--root` : nameClass }, name),
    h('span', { key: 'live', className: 'gp-copy-live', 'aria-live': 'polite' }, feedback === 'idle' ? '' : t(phrase)),
  ])
}
