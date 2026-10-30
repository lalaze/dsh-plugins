/**
 * One mermaid diagram inside rendered Markdown. The engine arrives through
 * the package-local lazy chunk (`require.async('./client.mermaid.js')`), the
 * same channel the official document preview uses for its pdf/excel chunks;
 * the main bundle never imports mermaid. A load or parse failure falls back
 * to the source as a plain code block — what the panel shows without mermaid
 * support — and the diagram re-renders when the shell flips its dark-theme
 * body attribute.
 */
import { createElement as h, useEffect, useState, type JSX } from 'react'
import type { GitKey } from './locales.js'

interface MermaidChunk {
  renderMermaid(source: string, theme: 'default' | 'dark'): Promise<string>
}

// The ModuleLoader factory's injected require; the chunk is package-local. Read when a figure loads, so the module
// also imports where no loader provides `require`, such as the plugin's Node tests.
const asyncRequire = (spec: string): Promise<unknown> => (require as unknown as { async(spec: string): Promise<unknown> }).async(spec)

let chunkPromise: Promise<MermaidChunk> | undefined
function loadChunk(): Promise<MermaidChunk> {
  // A failed load drops the memo so the next figure retries; the error itself
  // is reported per figure through the code-block fallback.
  chunkPromise ??= asyncRequire('./client.mermaid.js').then(
    (module) => module as MermaidChunk,
    (error) => {
      chunkPromise = undefined
      throw error
    },
  )
  return chunkPromise
}

/** The shell marks dark mode as a body attribute; mermaid themes are static per render. */
function currentTheme(): 'default' | 'dark' {
  return typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'default'
}

export function MermaidFigure({ source, t }: { readonly source: string; readonly t: (key: GitKey, params?: Record<string, string | number>) => string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [theme, setTheme] = useState(currentTheme)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return undefined
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let live = true
    setSvg(null)
    setFailed(false)
    loadChunk()
      .then((chunk) => chunk.renderMermaid(source, theme))
      .then((markup) => { if (live) setSvg(markup) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [source, theme])
  if (svg !== null) {
    return h('div', { className: 'gp-mermaid', 'data-mermaid': '', dangerouslySetInnerHTML: { __html: svg } })
  }
  if (failed) {
    return h('pre', { className: 'gp-mermaid__fallback', 'data-mermaid-fallback': '' }, h('code', null, source))
  }
  // A named skeleton, not an empty box: the chunk download can take a moment
  // on a remote origin, and the surrounding markdown has already rendered.
  return h('div', { className: 'gp-mermaid gp-mermaid--loading', 'data-mermaid': 'loading', role: 'status' },
    h('span', { className: 'gp-mermaid__loading-text' }, t('files.mermaidLoading')))
}
