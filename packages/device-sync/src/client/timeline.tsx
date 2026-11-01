import React from 'react'
import type { SyncedEvent } from '../shared/protocol.js'
import { attachmentUrl } from './api.js'
import { ui } from './i18n.js'

type Dict = Record<string, any>
const asDict = (value: unknown): Dict => (typeof value === 'object' && value !== null ? value as Dict : {})
const MAX_TOOL_TEXT = 20_000

const blockText = (content: unknown): string => Array.isArray(content)
  ? content.map(block => (asDict(block).type === 'text' ? String(asDict(block).text ?? '') : '')).filter(Boolean).join('\n')
  : typeof content === 'string' ? content : ''

function prettyArguments(raw: unknown): string {
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2)
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}
const clip = (text: string) => (text.length > MAX_TOOL_TEXT ? `${text.slice(0, MAX_TOOL_TEXT)}\n… ${ui('({0} more characters)', { 0: text.length - MAX_TOOL_TEXT })}` : text)

function Content({ content, deviceId, sessionId }: { content: unknown; deviceId: string; sessionId: string }) {
  if (!Array.isArray(content)) return null
  return <>{content.map((raw, index) => {
    const block = asDict(raw)
    if (block.type === 'text' && block.text) return <div key={index} className="dsy-msg-text">{String(block.text)}</div>
    if (block.type === 'image' && asDict(block.attachment).attachmentId) {
      const id = String(asDict(block.attachment).attachmentId)
      return <a key={index} href={attachmentUrl(deviceId, sessionId, id)} target="_blank" rel="noreferrer">
        <img src={attachmentUrl(deviceId, sessionId, id)} alt={String(asDict(block.attachment).name ?? ui('Image'))} loading="lazy" /></a>
    }
    if (block.type === 'file' && asDict(block.attachment).attachmentId) {
      const ref = asDict(block.attachment)
      return <a key={index} className="dsy-link" href={attachmentUrl(deviceId, sessionId, String(ref.attachmentId))} download={String(ref.name ?? 'file')}>
        {ui('File: {0}', { 0: String(ref.name ?? ref.attachmentId) })}{typeof ref.bytes === 'number' ? ` (${Math.ceil(ref.bytes / 1024)} KB)` : ''}</a>
    }
    return null
  })}</>
}

function Tool({ name, args, result }: { name: string; args: unknown; result?: Dict }) {
  const output = result ? blockText(asDict(result.message).content) : ''
  const failed = asDict(result?.message).isError === true
  return <details className="dsy-tool">
    <summary>{failed ? ui('{0} failed', { 0: name }) : result ? name : ui('{0} (running)', { 0: name })}</summary>
    <pre className="dsy-mono">{clip(prettyArguments(args))}</pre>
    {result && <pre className="dsy-mono">{clip(output || ui('(no output)'))}</pre>}
  </details>
}

const OUTCOMES: Record<string, string> = { 'allowed-once': 'Allowed once', rejected: 'Denied', cancelled: 'Withdrawn', unavailable: 'Nobody could answer' }

/** A mirrored conversation, as read-only messages, tool cards and markers. */
export function Timeline({ events, draft, deviceId, sessionId }: { events: SyncedEvent[]; draft?: { text: string; reasoning: string }; deviceId: string; sessionId: string }) {
  const results = new Map<string, Dict>()
  const announced = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/result') results.set(String(asDict(asDict(event.data).message).toolCallId), asDict(event.data))
    if (event.type === 'assistant/message') {
      for (const block of asDict(asDict(event.data).message).content ?? []) if (asDict(block).type === 'tool-call') announced.add(String(asDict(block).id))
    }
  }
  const tools = new Map<string, string>()
  const rows: React.ReactNode[] = []
  for (const event of events) {
    const data = asDict(event.data)
    switch (event.type) {
      case 'user/message': {
        const message = data.content ? data : asDict(data.message)
        rows.push(<div key={event.seq} className="dsy-msg" data-role="user"><Content content={message.content} deviceId={deviceId} sessionId={sessionId} /></div>)
        break
      }
      case 'assistant/message': {
        const content = asDict(data.message).content
        const parts: React.ReactNode[] = []
        for (const [index, raw] of (Array.isArray(content) ? content : []).entries()) {
          const block = asDict(raw)
          if (block.type === 'reasoning' && block.text) parts.push(<details key={`r${index}`} className="dsy-reasoning"><summary>{ui('Thinking')}</summary><div className="dsy-msg-text">{String(block.text)}</div></details>)
          else if (block.type === 'tool-call') { tools.set(String(block.id), String(block.name)); parts.push(<Tool key={`t${index}`} name={String(block.name)} args={block.arguments} result={results.get(String(block.id))} />) }
        }
        rows.push(<div key={event.seq} className="dsy-msg" data-role="assistant">
          <Content content={(Array.isArray(content) ? content : []).filter((b: unknown) => asDict(b).type !== 'tool-call')} deviceId={deviceId} sessionId={sessionId} />
          {parts}{data.interrupted && <span className="dsy-marker">{ui('Interrupted')}</span>}</div>)
        break
      }
      case 'tool/call':
        // Shown with its assistant message; a call without one still gets a card.
        if (!announced.has(String(data.callId))) rows.push(<Tool key={event.seq} name={String(data.name)} args={data.arguments} result={results.get(String(data.callId))} />)
        break
      case 'approval/asked':
        rows.push(<div key={event.seq} className="dsy-marker">{ui('Asked to approve {0}', { 0: String(data.toolName ?? tools.get(String(data.callId)) ?? '') })}{data.reason ? ` — ${String(data.reason)}` : ''}</div>)
        break
      case 'approval/decided':
        rows.push(<div key={event.seq} className="dsy-marker">{ui(OUTCOMES[String(data.outcome)] ?? String(data.outcome))}</div>)
        break
      case 'turn/end':
        if (data.reason && data.reason !== 'completed' && data.reason !== 'stop') rows.push(<div key={event.seq} className="dsy-marker">{ui('Turn ended: {0}', { 0: String(asDict(data.reason).kind ?? data.reason) })}</div>)
        break
      case 'session/end-seed':
        rows.push(<div key={event.seq} className="dsy-marker">{ui('Forked here')}</div>)
        break
      default: break
    }
  }
  if (draft && (draft.text || draft.reasoning)) {
    rows.push(<div key="draft" className="dsy-msg dsy-draft" data-role="assistant" aria-live="polite">
      {draft.reasoning && !draft.text && <div className="dsy-reasoning dsy-msg-text">{draft.reasoning.slice(-600)}</div>}
      {draft.text && <div className="dsy-msg-text">{draft.text}</div>}
    </div>)
  }
  if (rows.length === 0) return <div className="dsy-empty">{ui('No messages yet.')}</div>
  return <>{rows}</>
}

/** The last user request and assistant answer, for starting a linked session elsewhere. */
export function recentContext(events: SyncedEvent[]): string {
  let user = '', assistant = ''
  for (const event of events) {
    if (event.type === 'user/message') { const d = asDict(event.data); user = blockText(d.content ?? asDict(d.message).content) }
    if (event.type === 'assistant/message') { const text = blockText(asDict(asDict(event.data).message).content); if (text) assistant = text }
  }
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
  return [user && `${ui('Last request')}:\n${cut(user, 1500)}`, assistant && `${ui('Last answer')}:\n${cut(assistant, 3000)}`].filter(Boolean).join('\n\n')
}
