/**
 * Tight stacked overview's checkout bar: the current checkout's absolute root
 * path (elided from the left, click-to-copy with a fast hover tip) beside the
 * branch chip, above the history search. It renders only in the tight tier —
 * the tier where the left column (repo list plus branch tree, which carry the
 * same identity) sits behind the drawer; with the column in the band the bar
 * would repeat it.
 */
import { createElement as h } from 'react'
import type { JSX } from 'react'
import type { GitSnapshot } from './types.js'
import type { GitKey } from './locales.js'
import { BranchIcon, CheckIcon, CopyIcon } from './icons.js'
import { useCopyFeedback } from './copy-feedback.js'
import { useHoverTip } from './tip.js'
import { rtlPathText } from './rtl-path.js'

type Translate = (key: GitKey, params?: Record<string, string | number>) => string

export function RepoBar({ snapshot, t }: { readonly snapshot: GitSnapshot; readonly t: Translate }): JSX.Element | null {
  const rootCopy = useCopyFeedback(snapshot.root)
  const tip = useHoverTip({ placement: 'below' })
  if (snapshot.root === '') return null
  const copied = rootCopy.feedback === 'copied'
  const branch = snapshot.branch
  return h('div', { className: 'gp-repobar' }, [
    h('button', {
      key: 'path', type: 'button',
      className: `gp-repobar__path${copied ? ' gp-repobar__path--copied' : ''}`,
      'aria-label': copied ? t('overview.rootCopied') : t('overview.copyRoot'),
      ...tip.tipProps(copied ? t('overview.rootCopied') : snapshot.root),
      onClick: () => { tip.hideTip(); rootCopy.copy(snapshot.root) },
    }, [
      h('code', { key: 'p', className: 'gp-repobar__code' },
        h('span', { key: 'b', className: 'gp-repobar__text' }, rtlPathText(snapshot.root))),
      copied ? h(CheckIcon, { key: 'ok', size: 12 }) : h(CopyIcon, { key: 'i', size: 12 }),
      h('span', { key: 'live', className: 'gp-copy-live', 'aria-live': 'polite' },
        copied ? t('overview.rootCopied') : ''),
    ]),
    h('span', {
      key: 'branch',
      className: `gp-repobar__branch${branch === null ? ' gp-repobar__branch--detached' : ''}`,
    }, [h(BranchIcon, { key: 'i', size: 11 }), branch === null ? t('pill.detached') : branch]),
    tip.tipNode,
  ])
}
