/**
 * Tool calls as a phone shows them: one line each with what the tool did and to what, folded into a group when several
 * follow each other. Tapping one opens a sheet with its details in a readable form: a command and its output, an edit
 * as a diff, a plan as a checklist.
 */
import React, { useState, type ReactNode } from 'react'
import { CopyButton, icons, Sheet } from './controls.js'
import { ui } from './i18n.js'

type Dict = Record<string, any>
const asDict = (value: unknown): Dict => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Dict : {})
const MAX_TEXT = 20_000

export type ToolState = 'running' | 'failed' | 'done'

/** A tool call in either source: a DSH session (name, arguments, result) or a background task (name, text). */
export interface ToolCall {
  id: string
  name: string
  args?: unknown
  /** The result's text, or a background task's description of the call. */
  output?: string
  state: ToolState
}

type Kind = 'command' | 'read' | 'write' | 'edit' | 'search' | 'web' | 'todo' | 'agent' | 'other'
interface Described { kind: Kind; verb: string; target: string }

const KIND_ICONS: Record<Kind, ReactNode> = {
  command: icons.terminal, read: icons.file, write: icons.file, edit: icons.edit, search: icons.find, web: icons.globe, todo: icons.list, agent: icons.agent, other: icons.tool,
}

export function parseArgs(raw: unknown): Dict {
  if (typeof raw === 'string') { try { return asDict(JSON.parse(raw)) } catch { return {} } }
  return asDict(raw)
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** A file path with its name stressed, so the part that matters stays readable when the path wraps. */
function PathLine({ path, extra }: { path: string; extra?: string }) {
  const name = basename(path), dir = path.slice(0, path.length - name.length)
  return <div className="detail-path"><span className="path-name">{name}</span>{dir && <span className="path-dir">{dir}</span>}{extra && <span className="detail-meta">{extra}</span>}</div>
}
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

/** A background task's call text is sometimes its arguments as JSON; read them as arguments then. */
export function jsonArgs(text: string | undefined): Dict | undefined {
  if (!text || !/^\s*\{/.test(text)) return undefined
  try { const value = JSON.parse(text); return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Dict : undefined } catch { return undefined }
}
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const pathOf = (args: Dict) => str(args.file_path) || str(args.path) || str(args.file) || str(args.notebook_path)

function todos(args: Dict): { content: string; status: string }[] {
  const list = Array.isArray(args.todos) ? args.todos : []
  return list.map(asDict).map(item => ({ content: str(item.content) || str(item.title) || str(item.text), status: str(item.status) || 'pending' })).filter(item => item.content)
}

/** What a call did, in words: a verb for the kind of tool and the command, file or query it acted on. */
export function describeTool(name: string, rawArgs: unknown): Described {
  const args = parseArgs(rawArgs)
  const key = name.toLowerCase().replace(/^mcp__[^_]+__/, '')
  if (/^(bash|shell|sh|exec|exec_command|run_command|terminal|pwsh|powershell|local_shell)$/.test(key) || typeof args.command === 'string' || Array.isArray(args.command) || typeof args.cmd === 'string') {
    const command = Array.isArray(args.command) ? args.command.join(' ') : str(args.command) || str(args.cmd)
    const description = str(args.description)
    return description ? { kind: 'command', verb: description, target: firstLine(command) } : { kind: 'command', verb: ui('Run'), target: firstLine(command) }
  }
  if (/todo/.test(key)) {
    const list = todos(args)
    return { kind: 'todo', verb: ui('Update plan'), target: list.length ? ui('{0}/{1} done', { 0: list.filter(item => item.status === 'completed').length, 1: list.length }) : '' }
  }
  if (/^(read|read_file|read_image|view|cat|notebookread)$/.test(key)) return { kind: 'read', verb: ui('Read'), target: basename(pathOf(args)) }
  if (/^(write|write_file|create_file|create)$/.test(key)) return { kind: 'write', verb: ui('Write'), target: basename(pathOf(args)) }
  if (/edit|str_replace|apply_patch|patch|notebookedit/.test(key)) return { kind: 'edit', verb: ui('Edit'), target: basename(pathOf(args)) || firstLine(str(args.patch) || str(args.input)).replace(/^\*\*\* (Begin Patch|Update File: )/, '') }
  if (/^(grep|glob|find|search|search_files|list|ls|list_files|codebase_search)$/.test(key)) return { kind: 'search', verb: ui('Search'), target: str(args.pattern) || str(args.query) || pathOf(args) }
  if (/web_?search/.test(key)) return { kind: 'web', verb: ui('Search the web'), target: str(args.query) }
  if (/web_?fetch|fetch|browse|open_url/.test(key)) return { kind: 'web', verb: ui('Open page'), target: str(args.url).replace(/^https?:\/\//, '') }
  if (/agent|task|subagent|delegate/.test(key)) return { kind: 'agent', verb: ui('Sub-agent'), target: firstLine(str(args.description) || str(args.prompt) || str(args.title)) }
  for (const field of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = args[field]
    if (typeof value === 'string' && value.trim()) return { kind: 'other', verb: name, target: firstLine(value).slice(0, 160) }
  }
  return { kind: 'other', verb: name, target: '' }
}

const stateOf = (tools: ToolCall[]): ToolState => tools.some(tool => tool.state === 'running') ? 'running' : tools.some(tool => tool.state === 'failed') ? 'failed' : 'done'

function StateMark({ state }: { state: ToolState }) {
  if (state === 'running') return <span className="spinner small" aria-label={ui('Running')} />
  if (state === 'failed') return <span className="tool-failed" aria-label={ui('Failed')}>{icons.warning}</span>
  return null
}

/** A background task's calls carry no arguments; the first line of their description names what they acted on. */
const targetOf = (tool: ToolCall, described: Described) => described.target || (tool.args === undefined && tool.output ? firstLine(tool.output).slice(0, 160) : '')

function ToolLine({ tool, onOpen }: { tool: ToolCall; onOpen(tool: ToolCall): void }) {
  const described = describeTool(tool.name, tool.args)
  const { kind, verb } = described, target = targetOf(tool, described)
  return <button type="button" className="tool-line" data-state={tool.state} onClick={() => onOpen(tool)}>
    <span className="tool-icon">{KIND_ICONS[kind]}</span>
    <span className="tool-verb">{verb}</span>
    {target && <span className="tool-target ellipsis">{target}</span>}
    <StateMark state={tool.state} />
  </button>
}

/** Consecutive tool calls: one line for a single call, a folded group for several. */
export function ToolGroup({ tools }: { tools: ToolCall[] }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<ToolCall>()
  const state = stateOf(tools)
  // The open sheet follows the call as it finishes.
  const current = shown ? tools.find(tool => tool.id === shown.id) ?? shown : undefined
  if (tools.length === 1) return <div className="tool-group single"><ToolLine tool={tools[0]} onOpen={setShown} />{current && <ToolSheet tool={current} onClose={() => setShown(undefined)} />}</div>
  const last = tools.at(-1)!
  const described = describeTool(last.name, last.args)
  const { verb } = described, target = targetOf(last, described)
  const failed = tools.filter(tool => tool.state === 'failed').length
  return <div className="tool-group" data-open={open}>
    <button type="button" className="tool-summary" data-state={state} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="tool-icon">{icons.tool}</span>
      <span className="tool-verb">{ui('{0} tool calls', { 0: tools.length })}</span>
      {failed > 0 && <span className="tool-failures">{ui('{0} failed', { 0: failed })}</span>}
      {!open && <span className="tool-hint ellipsis">{verb}{target ? ` · ${target}` : ''}</span>}
      {state === 'running' && <StateMark state={state} />}
      <span className="tool-chevron">{icons.chevronRight}</span>
    </button>
    {open && <div className="tool-list">{tools.map(tool => <ToolLine key={tool.id} tool={tool} onOpen={setShown} />)}</div>}
    {current && <ToolSheet tool={current} onClose={() => setShown(undefined)} />}
  </div>
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text)

function Block({ label, text, tone, copy = true }: { label?: string; text: string; tone?: 'failed'; copy?: boolean }) {
  return <div className="detail-block">
    {(label || copy) && <div className="detail-head">{label && <span>{label}</span>}{copy && text && <CopyButton text={text} className="detail-copy" label={ui('Copy')} />}</div>}
    <pre className={`detail-pre${tone ? ` ${tone}` : ''}`}>{clip(text) || ui('(no output)')}</pre>
  </div>
}

/** A line diff of two texts, by longest common subsequence; long texts show as removed then added. */
export function lineDiff(before: string, after: string): { type: ' ' | '-' | '+'; text: string }[] {
  const a = before.split('\n'), b = after.split('\n')
  if (a.length * b.length > 250_000) return [...a.map(text => ({ type: '-' as const, text })), ...b.map(text => ({ type: '+' as const, text }))]
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const result: { type: ' ' | '-' | '+'; text: string }[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { result.push({ type: ' ', text: a[i] }); i++; j++ }
    else if (table[i + 1][j] >= table[i][j + 1]) result.push({ type: '-', text: a[i++] })
    else result.push({ type: '+', text: b[j++] })
  }
  while (i < a.length) result.push({ type: '-', text: a[i++] })
  while (j < b.length) result.push({ type: '+', text: b[j++] })
  return result
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after)
  return <div className="detail-block">
    <pre className="detail-pre diff">{lines.map((line, index) => <span key={index} className={`diff-line${line.type === '-' ? ' removed' : line.type === '+' ? ' added' : ''}`}>{line.type} {line.text}{'\n'}</span>)}</pre>
  </div>
}

function Checklist({ items }: { items: { content: string; status: string }[] }) {
  return <ul className="checklist">{items.map((item, index) => <li key={index} data-status={item.status}>
    <span className="check-box">{item.status === 'completed' ? icons.check : item.status === 'in_progress' ? <span className="check-dot" /> : null}</span>
    <span>{item.content}</span>
  </li>)}</ul>
}

function pretty(raw: unknown): string {
  if (raw === undefined) return ''
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2) ?? ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

/** The details of one call, by kind of tool. */
export function ToolSheet({ tool, onClose }: { tool: ToolCall; onClose(): void }) {
  const { kind, verb, target } = describeTool(tool.name, tool.args)
  const args = parseArgs(tool.args)
  const path = pathOf(args)
  const failed = tool.state === 'failed'
  const output = tool.output ?? ''
  let body: ReactNode
  const result = tool.state === 'running' ? <div className="working"><span className="spinner" />{ui('Running…')}</div>
    : tool.output === undefined ? null
    : <Block label={failed ? ui('Error') : ui('Output')} text={output} tone={failed ? 'failed' : undefined} />
  if (tool.args === undefined) body = <Block text={output} />
  else if (kind === 'command') {
    const command = Array.isArray(args.command) ? args.command.join(' ') : str(args.command) || str(args.cmd)
    body = <>{command && <Block label={ui('Command')} text={command} />}{str(args.workdir) && <div className="detail-meta">{ui('In {0}', { 0: str(args.workdir) })}</div>}{result}</>
  } else if (kind === 'edit' && (typeof args.old_string === 'string' || typeof args.new_string === 'string')) {
    body = <>{path && <PathLine path={path} />}<Diff before={str(args.old_string) || str(args.old_str)} after={str(args.new_string) || str(args.new_str)} />{failed && result}</>
  } else if (kind === 'edit' && Array.isArray(args.edits)) {
    body = <>{path && <PathLine path={path} />}{args.edits.map(asDict).map((edit, index) => <Diff key={index} before={str(edit.old_string)} after={str(edit.new_string)} />)}{failed && result}</>
  } else if (kind === 'write' && typeof args.content === 'string') {
    body = <>{path && <PathLine path={path} />}<Block label={ui('Content')} text={args.content} />{failed && result}</>
  } else if (kind === 'todo') {
    body = <><Checklist items={todos(args)} />{failed && result}</>
  } else if (kind === 'read') {
    const range = typeof args.offset === 'number' ? ui('Lines {0}–{1}', { 0: args.offset, 1: args.offset + (typeof args.limit === 'number' ? args.limit : 0) }) : ''
    body = <>{path && <PathLine path={path} extra={range} />}{result}</>
  } else {
    body = <><Block label={ui('Input')} text={pretty(tool.args)} />{result}</>
  }
  return <Sheet className="tall" onClose={onClose} title={<span className="tool-sheet-title"><span className="tool-icon">{KIND_ICONS[kind]}</span><span className="ellipsis">{verb}</span><StateMark state={tool.state} /></span>}>
    <div className="tool-detail">
      {target && kind !== 'command' && kind !== 'todo' && !path && <div className="detail-path">{target}</div>}
      {body}
    </div>
  </Sheet>
}
