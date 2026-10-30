/**
 * Segment splitter for rendered-Markdown mermaid support. `MarkdownText` has
 * no code-block renderer hook, so a document is split at top-level ```mermaid
 * fences: every mermaid block renders through the lazy mermaid chunk while all
 * other segments stay on the official MarkdownText.
 *
 * CommonMark subset, intentionally top-level only: a fence indented into a
 * list or blockquote stays inside its markdown segment (it renders as a plain
 * code block, exactly as today). Non-mermaid fences pass through untouched so
 * a fenced example that *contains* a mermaid fence is never mis-split.
 */

export type MermaidSegment =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'mermaid'; readonly source: string }

interface Fence {
  readonly marker: '`' | '~'
  readonly length: number
  readonly info: string
}

/** Parse one potential fence line (up to 3 indent spaces, CommonMark). */
function fenceOf(line: string): Fence | null {
  // Fence syntax is line-based: a CRLF document leaves `\r` at every line end,
  // which JS `.` and end-anchored `$` refuse to match. Strip it for detection
  // only — line content stays verbatim in segments and sources.
  const probe = line.endsWith('\r') ? line.slice(0, -1) : line
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(probe)
  if (match === null) return null
  const marker = match[1][0] as '`' | '~'
  const info = match[2].trim()
  // Backtick info strings cannot contain backticks (CommonMark 4.4).
  if (marker === '`' && info.includes('`')) return null
  return { marker, length: match[1].length, info }
}

/** A closing fence: same marker, at least the opening length, no info string. */
function isClose(line: string, open: Fence): boolean {
  const fence = fenceOf(line)
  return fence !== null && fence.marker === open.marker && fence.length >= open.length && fence.info === ''
}

/** Whether a fence's info string names mermaid (first word, case-insensitive). */
function isMermaidInfo(info: string): boolean {
  return /^mermaid(\s|$)/i.test(info)
}

/**
 * Split one Markdown document into alternating markdown and mermaid segments.
 * A document without mermaid fences is a single markdown segment holding the
 * input verbatim.
 */
export function splitMermaidSegments(markdown: string): MermaidSegment[] {
  const lines = markdown.split('\n')
  const segments: MermaidSegment[] = []
  let markdownBuf: string[] = []
  let mermaidBuf: string[] | null = null
  let open: Fence | null = null
  let sawMermaid = false
  const flushMarkdown = (): void => {
    if (markdownBuf.length === 0) return
    const text = markdownBuf.join('\n')
    markdownBuf = []
    // An empty buffered segment (e.g. the newline after a closing fence) has
    // no rendering meaning; only the no-mermaid path preserves input verbatim.
    if (text === '') return
    segments.push({ kind: 'markdown', text })
  }
  for (const line of lines) {
    if (mermaidBuf !== null && open !== null) {
      if (isClose(line, open)) {
        segments.push({ kind: 'mermaid', source: mermaidBuf.join('\n') })
        mermaidBuf = null
        open = null
      } else {
        mermaidBuf.push(line)
      }
      continue
    }
    if (open !== null) {
      markdownBuf.push(line)
      if (isClose(line, open)) open = null
      continue
    }
    const fence = fenceOf(line)
    if (fence !== null && isMermaidInfo(fence.info)) {
      flushMarkdown()
      sawMermaid = true
      mermaidBuf = []
      open = fence
      continue
    }
    markdownBuf.push(line)
    if (fence !== null) open = fence
  }
  // An unclosed mermaid fence runs to end of input, like a CommonMark code block.
  if (mermaidBuf !== null) segments.push({ kind: 'mermaid', source: mermaidBuf.join('\n') })
  flushMarkdown()
  return sawMermaid ? segments : [{ kind: 'markdown', text: markdown }]
}

/**
 * Render `<kbd>…</kbd>` as inline code. The platform `MarkdownText` returns
 * raw-HTML nodes as their literal value (an intentional escape — inline HTML
 * never executes), so keyboard hints would otherwise show as angle-bracket
 * text. Only prose outside fences and outside inline-code spans changes;
 * fenced examples keep their literal text. Line-granular: an inline-code
 * span crossing a line break is masked per line (rare, cosmetic only).
 */
export function markdownKbdToCode(markdown: string): string {
  const lines = markdown.split('\n')
  let open: Fence | null = null
  return lines.map((line) => {
    if (open !== null) {
      if (isClose(line, open)) open = null
      return line
    }
    const fence = fenceOf(line)
    if (fence !== null) {
      open = fence
      return line
    }
    return kbdOutsideInlineCode(line)
  }).join('\n')
}

/** Replace `<kbd>x</kbd>` with an inline-code span everywhere except inside backtick spans. */
function kbdOutsideInlineCode(line: string): string {
  const inlineCode = /(`+)[\s\S]*?\1/g
  const kbd = /<kbd>([\s\S]*?)<\/kbd>/gi
  const substitute = (_match: string, body: string): string => kbdToCode(body)
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = inlineCode.exec(line)) !== null) {
    out += line.slice(last, match.index).replace(kbd, substitute)
    out += match[0]
    last = match.index + match[0].length
  }
  return out + line.slice(last).replace(kbd, substitute)
}

/**
 * Wrap kbd content as one valid inline-code span (CommonMark backtick rules):
 * the delimiter run is longer than any run inside the content, and content
 * starting/ending with a backtick is padded with a space.
 */
function kbdToCode(body: string): string {
  let longest = 0
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(longest + 1)
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${body}${pad}${fence}`
}
