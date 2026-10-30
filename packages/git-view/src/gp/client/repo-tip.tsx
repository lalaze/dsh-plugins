/**
 * Hover-tip content for one repository row, shared by every copy of the
 * repository list: each detail sits on its own icon-led line (the
 * reason line stays text — it is a preface, not a fact about the checkout),
 * and a hairline above the path separates where you are from which branch
 * you are on. The tip itself stays the shared portal in `tip.tsx`.
 */
import { createElement as h } from 'react'
import type { JSX } from 'react'
import type { RepoTipLine } from './repo-list.js'
import { BranchIcon, FolderIcon } from './icons.js'

export function repoTipContent(lines: readonly RepoTipLine[]): JSX.Element {
  const nodes: JSX.Element[] = []
  lines.forEach((line, index) => {
    if (line.kind === 'path' && index > 0) nodes.push(h('span', { key: 'sep', className: 'gp-tip__sep' }))
    const icon = line.kind === 'branch'
      ? h(BranchIcon, { key: 'i', size: 12 })
      : line.kind === 'path' ? h(FolderIcon, { key: 'i', size: 12 }) : null
    nodes.push(h('span', { key: line.kind, className: `gp-tip__line gp-tip__line--${line.kind}` }, [
      icon === null ? null : h('span', { key: 'ic', className: 'gp-tip__ic' }, icon),
      h('span', { key: 't', className: 'gp-tip__text' }, line.text),
    ]))
  })
  return h('span', { className: 'gp-tip__lines' }, nodes)
}
