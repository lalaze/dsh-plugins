/** A conversation as messages, with consecutive tool calls folded into one row, as Paseo shows them. */
import React, { memo, useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SyncedEvent } from '../../src/shared/protocol.js'
import { CopyButton, icons, useBackClose } from './controls.js'
import type { HubState } from './store.js'
import { ui } from './i18n.js'
import { ToolGroup, type ToolCall } from './tools.js'

type Dict = Record<string, any>
const asDict = (value: unknown): Dict => (typeof value === 'object' && value !== null ? value as Dict : {})

const blockText = (content: unknown): string => Array.isArray(content)
  ? content.map(block => (asDict(block).type === 'text' ? String(asDict(block).text ?? '') : '')).filter(Boolean).join('\n')
  : typeof content === 'string' ? content : ''

/** Text of a node tree react-markdown rendered, for copying a code block. */
const nodeText = (node: ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (React.isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

export const Text = memo(function Text({ text }: { text: string }) {
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    pre: ({ node: _node, children, ...props }) => {
      const language = /language-([\w-]+)/.exec(String((React.isValidElement(children) ? (children.props as { className?: string }).className : '') ?? ''))?.[1]
      return <div className="code-block">
        <div className="code-head"><span>{language ?? ''}</span><CopyButton text={nodeText(children).replace(/\n$/, '')} className="code-copy" label={ui('Copy')} /></div>
        <pre {...props}>{children}</pre>
      </div>
    },
    table: ({ node: _node, ...props }) => <div className="table-scroll"><table {...props} /></div>,
  }}>{text}</Markdown></div>
})

/** An image full screen; a tap or back closes it, pinching zooms. */
export function Lightbox({ url, name, onClose }: { url: string; name?: string; onClose(): void }) {
  useBackClose(onClose)
  return <div className="lightbox" role="dialog" aria-label={name ?? ui('Image')} onClick={onClose}>
    <img src={url} alt={name ?? ''} />
    <button type="button" className="lightbox-close" aria-label={ui('Close')} onClick={onClose}>{icons.close}</button>
  </div>
}

function Attachment({ state, sessionId, block }: { state: HubState; sessionId: string; block: Dict }) {
  const attachment = asDict(block.attachment)
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const id = String(attachment.attachmentId ?? '')
  const image = block.type === 'image'
  const name = String(attachment.name ?? ui('Image'))
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
  if (!image) return <div className="chip">{icons.file}<span className="ellipsis">{String(attachment.name ?? id)}</span></div>
  if (url) return <>
    <button type="button" className="thumb-button" onClick={() => setZoomed(true)}><img className="thumb" src={url} alt={name} /></button>
    {zoomed && <Lightbox url={url} name={name} onClose={() => setZoomed(false)} />}
  </>
  return <div className="thumb placeholder">{failed ? ui('Image') : <span className="spinner" />}</div>
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

const OUTCOMES: Record<string, string> = { 'allowed-once': 'Allowed once', rejected: 'Denied', cancelled: 'Withdrawn', unavailable: 'Nobody could answer' }

/** Context DSH injected as a user message (instructions, skills, runtime and time snapshots); its view hides it too. */
export const injected = (data: Dict) => typeof asDict(data.source).form === 'string' || /-(context|catalog|instructions)$/.test(String(asDict(data.source).kind ?? ''))

/** The text of a user message event the conversation shows, or undefined for injected context. */
export function userText(event: SyncedEvent): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = asDict(event.data)
  if (injected(data)) return undefined
  return blockText((data.content ? data : asDict(data.message)).content)
}

/** The arguments of a tool call, as announced in the session, for showing what an approval is about. */
export function toolArguments(events: SyncedEvent[], callId: string | undefined): unknown {
  if (!callId) return undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index], data = asDict(event.data)
    if (event.type === 'tool/call' && String(data.callId) === callId) return data.arguments
    if (event.type === 'assistant/message') for (const block of asDict(data.message).content ?? []) if (asDict(block).type === 'tool-call' && String(asDict(block).id) === callId) return asDict(block).arguments
  }
  return undefined
}

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return ui('{0}s', { 0: seconds })
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? ui('{0}m {1}s', { 0: minutes, 1: seconds % 60 }) : ui('{0}h {1}m', { 0: Math.floor(minutes / 60), 1: minutes % 60 })
}

function TurnMeta({ ms, text }: { ms?: number; text: string }) {
  return <div className="turn-meta">
    {text && <CopyButton text={text} className="meta-button" />}
    {ms !== undefined && <span>{ui('Worked for {0}', { 0: duration(ms) })}</span>}
  </div>
}

const toolCall = (id: string, name: string, args: unknown, result: Dict | undefined): ToolCall => ({
  id, name, args,
  output: result ? blockText(asDict(result.message).content) : undefined,
  state: !result ? 'running' : asDict(result.message).isError === true ? 'failed' : 'done',
})

export function Timeline({ events, draft, state, sessionId }: { events: SyncedEvent[]; draft?: { text: string; reasoning: string }; state: HubState; sessionId: string }) {
  const results = new Map<string, Dict>()
  const announced = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/result') results.set(String(asDict(asDict(event.data).message).toolCallId), asDict(event.data))
    if (event.type === 'assistant/message') for (const block of asDict(asDict(event.data).message).content ?? []) if (asDict(block).type === 'tool-call') announced.add(String(asDict(block).id))
  }
  const rows: React.ReactNode[] = []
  let tools: ToolCall[] = []
  let turnStart: number | undefined, turnText = ''
  // Keyed by its first call, so a group stays mounted (with any sheet open) as the agent goes on.
  const flush = (_at: string) => { if (tools.length) { rows.push(<ToolGroup key={`tools-${tools[0].id}`} tools={tools} />); tools = [] } }
  for (const event of events) {
    const data = asDict(event.data)
    switch (event.type) {
      case 'turn/start': turnStart = event.time; turnText = ''; break
      case 'user/message': {
        if (injected(data)) break
        flush(String(event.seq))
        const message = data.content ? data : asDict(data.message)
        rows.push(<div key={event.seq} className="msg user"><Content content={message.content} state={state} sessionId={sessionId} /></div>)
        break
      }
      case 'assistant/message': {
        const content = Array.isArray(asDict(data.message).content) ? asDict(data.message).content as unknown[] : []
        const reasoning = content.map(asDict).filter(block => block.type === 'reasoning' && block.text).map(block => String(block.text)).join('\n\n')
        const text = blockText(content)
        if (text) turnText = text
        if (reasoning || text) flush(String(event.seq))
        if (reasoning) rows.push(<details key={`r${event.seq}`} className="reasoning"><summary>{icons.sparkle}<span>{ui('Thinking')}</span>{icons.chevronRight}</summary><Text text={reasoning} /></details>)
        if (text || content.some(block => ['image', 'file'].includes(asDict(block).type))) rows.push(<div key={event.seq} className="msg assistant"><Content content={content.filter(block => asDict(block).type !== 'tool-call' && asDict(block).type !== 'reasoning')} state={state} sessionId={sessionId} /></div>)
        for (const block of content.map(asDict).filter(block => block.type === 'tool-call')) tools.push(toolCall(String(block.id), String(block.name), block.arguments, results.get(String(block.id))))
        if (data.interrupted) { flush(`i${event.seq}`); rows.push(<div key={`i${event.seq}`} className="marker">{ui('Interrupted')}</div>) }
        break
      }
      case 'tool/call':
        if (!announced.has(String(data.callId))) tools.push(toolCall(String(data.callId), String(data.name), data.arguments, results.get(String(data.callId))))
        break
      case 'approval/asked':
        flush(String(event.seq))
        rows.push(<div key={event.seq} className="marker">{ui('Asked to approve {0}', { 0: String(data.toolName ?? '') })}{data.reason ? ` — ${String(data.reason)}` : ''}</div>)
        break
      case 'approval/decided':
        rows.push(<div key={event.seq} className="marker">{ui(OUTCOMES[String(data.outcome)] ?? String(data.outcome))}</div>)
        break
      case 'turn/end': {
        flush(String(event.seq))
        const reason = asDict(data.reason), kind = String(reason.kind ?? data.reason ?? 'completed')
        if (kind === 'cancelled' || kind === 'interrupted' || kind === 'aborted') rows.push(<div key={event.seq} className="marker">{ui('Stopped')}</div>)
        else if (kind === 'error' || kind === 'failed') rows.push(<div key={event.seq} className="marker error">{ui('Failed: {0}', { 0: String(reason.message ?? asDict(reason.error).message ?? kind) })}</div>)
        else if (kind !== 'completed' && kind !== 'stop' && kind !== 'end-turn') rows.push(<div key={event.seq} className="marker">{ui('Turn ended: {0}', { 0: kind })}</div>)
        rows.push(<TurnMeta key={`m${event.seq}`} ms={turnStart !== undefined ? event.time - turnStart : undefined} text={turnText} />)
        turnStart = undefined; turnText = ''
        break
      }
      default: break
    }
  }
  flush('end')
  if (draft && (draft.text || draft.reasoning)) {
    rows.push(<div key="draft" className="msg assistant draft" aria-live="polite">
      {draft.text ? <Text text={draft.text} /> : <div className="reasoning-live">{icons.sparkle}<span>{draft.reasoning.slice(-400)}</span></div>}
    </div>)
  }
  return <>{rows}</>
}
