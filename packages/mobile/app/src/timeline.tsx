/** A conversation as messages, with consecutive tool calls folded into one row, as Paseo shows them. */
import React, { memo, useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SyncedEvent } from '../../src/shared/protocol.js'
import type { HubState } from './store.js'
import { ui } from './i18n.js'

type Dict = Record<string, any>
const asDict = (value: unknown): Dict => (typeof value === 'object' && value !== null ? value as Dict : {})
const MAX_TOOL_TEXT = 12_000

const blockText = (content: unknown): string => Array.isArray(content)
  ? content.map(block => (asDict(block).type === 'text' ? String(asDict(block).text ?? '') : '')).filter(Boolean).join('\n')
  : typeof content === 'string' ? content : ''

function pretty(raw: unknown): string {
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2) ?? ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}
const clip = (text: string) => (text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n…` : text)

/** A one-line summary of a tool call's arguments: the command, path or query it acts on. */
function summary(args: unknown): string {
  let value: Dict = {}
  try { value = asDict(typeof args === 'string' ? JSON.parse(args) : args) } catch { return '' }
  for (const key of ['command', 'cmd', 'path', 'file_path', 'file', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const field = value[key]
    if (typeof field === 'string' && field.trim()) return field.trim().split('\n')[0].slice(0, 120)
    if (Array.isArray(field) && field.length) return field.join(' ').slice(0, 120)
  }
  return ''
}

const Text = memo(function Text({ text }: { text: string }) {
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</Markdown></div>
})

function Attachment({ state, sessionId, block }: { state: HubState; sessionId: string; block: Dict }) {
  const attachment = asDict(block.attachment)
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const id = String(attachment.attachmentId ?? '')
  const image = block.type === 'image'
  useEffect(() => {
    if (!image || !id) return
    let revoked = false, objectUrl: string | undefined
    void state.client.call('attachment', { sessionId, attachmentId: id }).then(result => {
      if (revoked) return
      const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mediaType }))
      setUrl(objectUrl)
    }, () => setFailed(true))
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id, image, sessionId, state])
  if (!image) return <div className="chip">{ui('File: {0}', { 0: String(attachment.name ?? id) })}</div>
  if (url) return <a href={url} target="_blank" rel="noreferrer"><img className="thumb" src={url} alt={String(attachment.name ?? ui('Image'))} /></a>
  return <div className="thumb placeholder">{failed ? ui('Image') : ''}</div>
}

function Content({ content, state, sessionId }: { content: unknown; state: HubState; sessionId: string }) {
  if (typeof content === 'string') return <Text text={content} />
  if (!Array.isArray(content)) return null
  const images = content.filter(block => ['image', 'file'].includes(asDict(block).type) && asDict(asDict(block).attachment).attachmentId)
  const text = blockText(content)
  return <>
    {images.length > 0 && <div className="attachments">{images.map((block, index) => <Attachment key={index} state={state} sessionId={sessionId} block={asDict(block)} />)}</div>}
    {text && <Text text={text} />}
  </>
}

interface ToolRow { id: string; name: string; args: unknown; result?: Dict }

function Tools({ tools }: { tools: ToolRow[] }) {
  const running = tools.some(tool => !tool.result)
  const failed = tools.some(tool => asDict(tool.result?.message).isError === true)
  const last = tools.at(-1)!
  const label = tools.length === 1
    ? `${last.name}${summary(last.args) ? ` · ${summary(last.args)}` : ''}`
    : `${ui('{0} tool calls', { 0: tools.length })} · ${last.name}${summary(last.args) ? ` ${summary(last.args)}` : ''}`
  return <details className="tools" data-state={running ? 'running' : failed ? 'failed' : 'done'}>
    <summary><span className="tool-dot" /><span className="ellipsis">{label}</span></summary>
    {tools.map(tool => <div key={tool.id} className="tool">
      <div className="tool-name">{asDict(tool.result?.message).isError === true ? ui('{0} failed', { 0: tool.name }) : tool.result ? tool.name : ui('{0} (running)', { 0: tool.name })}</div>
      <pre>{clip(pretty(tool.args))}</pre>
      {tool.result && <pre>{clip(blockText(asDict(tool.result.message).content) || ui('(no output)'))}</pre>}
    </div>)}
  </details>
}

const OUTCOMES: Record<string, string> = { 'allowed-once': 'Allowed once', rejected: 'Denied', cancelled: 'Withdrawn', unavailable: 'Nobody could answer' }

export function Timeline({ events, draft, state, sessionId }: { events: SyncedEvent[]; draft?: { text: string; reasoning: string }; state: HubState; sessionId: string }) {
  const results = new Map<string, Dict>()
  const announced = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/result') results.set(String(asDict(asDict(event.data).message).toolCallId), asDict(event.data))
    if (event.type === 'assistant/message') for (const block of asDict(asDict(event.data).message).content ?? []) if (asDict(block).type === 'tool-call') announced.add(String(asDict(block).id))
  }
  const rows: React.ReactNode[] = []
  let tools: ToolRow[] = []
  const flush = (key: string) => { if (tools.length) { rows.push(<Tools key={`tools-${key}`} tools={tools} />); tools = [] } }
  for (const event of events) {
    const data = asDict(event.data)
    switch (event.type) {
      case 'user/message': {
        flush(String(event.seq))
        const message = data.content ? data : asDict(data.message)
        rows.push(<div key={event.seq} className="msg user"><Content content={message.content} state={state} sessionId={sessionId} /></div>)
        break
      }
      case 'assistant/message': {
        const content = Array.isArray(asDict(data.message).content) ? asDict(data.message).content as unknown[] : []
        const reasoning = content.map(asDict).filter(block => block.type === 'reasoning' && block.text).map(block => String(block.text)).join('\n\n')
        const text = blockText(content)
        if (reasoning || text) flush(String(event.seq))
        if (reasoning) rows.push(<details key={`r${event.seq}`} className="reasoning"><summary>{ui('Thinking')}</summary><Text text={reasoning} /></details>)
        if (text || content.some(block => ['image', 'file'].includes(asDict(block).type))) rows.push(<div key={event.seq} className="msg assistant"><Content content={content.filter(block => asDict(block).type !== 'tool-call' && asDict(block).type !== 'reasoning')} state={state} sessionId={sessionId} /></div>)
        for (const block of content.map(asDict).filter(block => block.type === 'tool-call')) tools.push({ id: String(block.id), name: String(block.name), args: block.arguments, result: results.get(String(block.id)) })
        if (data.interrupted) { flush(`i${event.seq}`); rows.push(<div key={`i${event.seq}`} className="marker">{ui('Interrupted')}</div>) }
        break
      }
      case 'tool/call':
        if (!announced.has(String(data.callId))) tools.push({ id: String(data.callId), name: String(data.name), args: data.arguments, result: results.get(String(data.callId)) })
        break
      case 'approval/asked':
        flush(String(event.seq))
        rows.push(<div key={event.seq} className="marker">{ui('Asked to approve {0}', { 0: String(data.toolName ?? '') })}{data.reason ? ` — ${String(data.reason)}` : ''}</div>)
        break
      case 'approval/decided':
        rows.push(<div key={event.seq} className="marker">{ui(OUTCOMES[String(data.outcome)] ?? String(data.outcome))}</div>)
        break
      case 'turn/end':
        flush(String(event.seq))
        if (data.reason && data.reason !== 'completed' && data.reason !== 'stop') rows.push(<div key={event.seq} className="marker">{ui('Turn ended: {0}', { 0: String(asDict(data.reason).kind ?? data.reason) })}</div>)
        break
      case 'session/end-seed':
        flush(String(event.seq))
        rows.push(<div key={event.seq} className="marker">{ui('Forked here')}</div>)
        break
      default: break
    }
  }
  flush('end')
  if (draft && (draft.text || draft.reasoning)) {
    rows.push(<div key="draft" className="msg assistant draft" aria-live="polite">
      {draft.text ? <Text text={draft.text} /> : <div className="reasoning-live">{draft.reasoning.slice(-500)}</div>}
    </div>)
  }
  return <>{rows}</>
}
