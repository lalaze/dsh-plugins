/**
 * A background task from Remote Agents: a remote CLI session with no DSH conversation, such as one DSH's agent
 * delegated. Its history follows while the screen is open; it can be steered, stopped and its approvals answered.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TaskEntry, TaskItem, TaskPage, TaskPermission } from '../../src/shared/protocol.js'
import { Composer, type Draft } from './composer.js'
import { errorText, ui } from './i18n.js'
import { requestId } from './parts.js'
import type { HubState } from './store.js'
import { Text } from './timeline.js'

const CLI_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', dsh: 'DeepSeek Harness', antigravity: 'Antigravity', grok: 'Grok', codebuddy: 'CodeBuddy Code' }
export const cliName = (provider: string) => CLI_NAMES[provider] ?? provider
export const busyTask = (task: TaskEntry | undefined) => task?.status === 'running' || task?.status === 'starting' || task?.status === 'attention'
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** Items of two adjacent pages as one list: a reply streamed across them is one item, and a tool call keeps its latest state. */
export function joinItems(before: TaskItem[], after: TaskItem[]): TaskItem[] {
  const items = before.map(item => ({ ...item }))
  const tools = new Map(items.filter(item => item.type === 'tool' && item.callId).map(item => [item.callId!, item]))
  for (const item of after) {
    const last = items.at(-1)
    if ((item.type === 'assistant' || item.type === 'reasoning') && last?.type === item.type) { last.text = (last.text ?? '') + (item.text ?? ''); continue }
    const tool = item.callId ? tools.get(item.callId) : undefined
    if (item.type === 'tool' && tool) { Object.assign(tool, { ...item, seq: tool.seq, time: tool.time }); continue }
    const copy = { ...item }
    if (copy.type === 'tool' && copy.callId) tools.set(copy.callId, copy)
    items.push(copy)
  }
  return items
}

function Tools({ tools }: { tools: TaskItem[] }) {
  const running = tools.some(tool => tool.status === 'running' || tool.status === 'pending')
  const failed = tools.some(tool => tool.status === 'failed' || tool.status === 'canceled')
  const last = tools.at(-1)!
  const label = tools.length === 1 ? last.name ?? ui('Tool') : `${ui('{0} tool calls', { 0: tools.length })} · ${last.name ?? ''}`
  return <details className="tools" data-state={running ? 'running' : failed ? 'failed' : 'done'}>
    <summary><span className="tool-dot" /><span className="ellipsis">{label}</span></summary>
    {tools.map(tool => <div key={tool.callId ?? tool.seq} className="tool">
      <div className="tool-name">{tool.status === 'failed' ? ui('{0} failed', { 0: tool.name ?? '' }) : tool.status === 'running' || tool.status === 'pending' ? ui('{0} (running)', { 0: tool.name ?? '' }) : tool.name}</div>
      {tool.text && <pre>{tool.text}</pre>}
    </div>)}
  </details>
}

function Items({ items }: { items: TaskItem[] }) {
  const rows: React.ReactNode[] = []
  let tools: TaskItem[] = []
  const flush = () => { if (tools.length) { rows.push(<Tools key={`tools-${tools[0].seq}`} tools={tools} />); tools = [] } }
  for (const item of items) {
    if (item.type === 'tool') { tools.push(item); continue }
    if (item.type === 'reasoning') { if (item.text?.trim()) { flush(); rows.push(<details key={item.seq} className="reasoning"><summary>{ui('Thinking')}</summary><Text text={item.text} /></details>) } continue }
    flush()
    switch (item.type) {
      case 'user': rows.push(<div key={item.seq} className="msg user"><Text text={item.text ?? ''} /></div>); break
      case 'assistant': if (item.text?.trim()) rows.push(<div key={item.seq} className="msg assistant"><Text text={item.text} /></div>); break
      case 'error': rows.push(<div key={item.seq} className="marker error">{ui('Failed: {0}', { 0: item.text ?? '' })}</div>); break
      case 'interrupted': rows.push(<div key={item.seq} className="marker">{ui('Interrupted')}</div>); break
      case 'end': if (item.status === 'canceled') rows.push(<div key={item.seq} className="marker">{ui('Stopped')}</div>); break
    }
  }
  flush()
  return <>{rows}</>
}

function Approval({ permission, control, onAnswer }: { permission: TaskPermission; control: boolean; onAnswer(action: TaskPermission['actions'][number]): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return <div className="card attention">
    <div className="card-title">{ui('Approve {0}?', { 0: permission.title })}</div>
    {permission.description && <div className="card-text">{permission.description}</div>}
    {permission.detail && <pre className="card-pre">{permission.detail}</pre>}
    {control && permission.actions.length > 0
      ? <div className={`row-actions${permission.actions.length > 2 ? ' wrap' : ''}`}>
        {permission.actions.map((action, index) => <button key={`${action.id}-${index}`} className={`button${action.behavior === 'allow' ? ' primary' : ''}`} disabled={busy}
          onClick={() => { setBusy(true); void onAnswer(action).finally(() => setBusy(false)) }}>{ui(action.label)}</button>)}
      </div>
      : <div className="card-text">{ui('Answer this on the computer.')}</div>}
  </div>
}

export function TaskView({ state, taskId, onBack, onOpenSession }: { state: HubState; taskId: string; onBack(): void; onOpenSession(sessionId: string): void }) {
  const listed = state.tasks.find(task => task.id === taskId)
  const [task, setTask] = useState<TaskEntry | undefined>(listed)
  const [items, setItems] = useState<TaskItem[]>([])
  const [permissions, setPermissions] = useState<TaskPermission[]>([])
  const [page, setPage] = useState<Pick<TaskPage, 'epoch' | 'first' | 'last' | 'hasOlder'>>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState<Draft>({ text: '', images: [] })
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const latest = useRef(page)
  latest.current = page
  const control = state.client.info?.phone?.grants.control === true
  const online = state.client.state === 'online'

  const apply = (result: { task: TaskEntry; permissions: TaskPermission[] }) => { setTask(result.task); setPermissions(result.permissions); state.updateTask(result.task) }

  // The newest page first, then only what was added; a replaced history is read again.
  useEffect(() => {
    if (!online) return
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const current = latest.current
        const result = current?.last !== undefined
          ? await state.client.call('task.detail', { taskId, after: current.last, epoch: current.epoch })
          : await state.client.call('task.detail', { taskId })
        if (!live) return
        apply(result)
        const fresh = !current || result.page.reset
        setItems(previous => fresh ? result.page.items : joinItems(previous, result.page.items))
        setPage(previous => ({ epoch: result.page.epoch, first: fresh ? result.page.first : previous?.first ?? result.page.first,
          last: result.page.last ?? (fresh ? undefined : previous?.last), hasOlder: fresh ? result.page.hasOlder : previous?.hasOlder ?? false }))
        setLoading(false); setError(undefined)
        timer = setTimeout(() => void poll(), result.page.hasNewer ? 0 : busyTask(result.task) ? 1500 : 5000)
      } catch (failure) {
        if (!live) return
        setError(errorText(failure)); setLoading(false)
        timer = setTimeout(() => void poll(), 5000)
      }
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [taskId, online, state])

  useLayoutEffect(() => { const element = scroller.current; if (element && stick.current) element.scrollTop = element.scrollHeight }, [items, permissions])

  const earlier = async () => {
    if (!page?.first) return
    const element = scroller.current, before = element?.scrollHeight ?? 0
    try {
      const result = await state.client.call('task.detail', { taskId, before: page.first, epoch: page.epoch })
      if (result.page.reset) { setPage(undefined); return }
      setItems(previous => joinItems(result.page.items, previous))
      setPage(previous => previous && { ...previous, first: result.page.first ?? previous.first, hasOlder: result.page.hasOlder })
      requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - before })
    } catch (failure) { setError(errorText(failure)) }
  }

  const command = async (run: () => Promise<unknown>) => {
    try { await run(); setError(undefined) } catch (failure) { setError(errorText(failure)) }
  }
  const send = async () => {
    const text = draft.text.trim()
    if (!text) return
    setSending(true); stick.current = true
    const sent = draft
    setDraft({ text: '', images: [] })
    try { await state.client.call('task.command', { kind: 'send', taskId, requestId: requestId(), text }) }
    catch (failure) { setDraft(sent); setError(ui('Not sent: {0}', { 0: errorText(failure) })) }
    finally { setSending(false) }
  }

  const running = busyTask(task)
  const owner = task?.ownerSessionId ? state.sessions.get(task.ownerSessionId) : undefined
  const subtitle = task ? [`${cliName(task.provider)} · ${task.model}`, `${task.host}:${basename(task.cwd)}`].join(' · ') : state.hub.name
  return <div className="screen session">
    <header className="bar divided">
      <button className="icon" aria-label={ui('Back')} onClick={onBack}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
      <div className="bar-title">
        <div className="title-line">{task && <span className="dot" data-status={task.status === 'attention' ? 'waiting' : running ? 'running' : task.status === 'error' ? 'offline' : 'idle'} />}<span className="ellipsis">{task?.title ?? ui('Background task')}</span></div>
        <div className="subtitle ellipsis">{subtitle}</div>
      </div>
    </header>
    <div className="scroll" ref={scroller} onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80 }}>
      <div className="timeline">
        {task?.delegated && <div className="task-origin">
          {owner ? <button className="link" onClick={() => onOpenSession(owner.sessionId)}>{ui('Delegated from “{0}”', { 0: owner.title || ui('Untitled session') })}</button> : ui('Delegated by DSH')}
          {task.controller && <span> · {ui('In use on {0}', { 0: task.controller })}</span>}
        </div>}
        {page?.hasOlder && <button className="link center" onClick={() => void earlier()}>{ui('Load earlier')}</button>}
        {loading && <div className="empty">{ui('Connecting…')}</div>}
        <Items items={items} />
        {task?.status === 'error' && task.error && <div className="marker error">{task.error}</div>}
        {running && permissions.length === 0 && <div className="working"><span className="spinner" />{ui('Working…')}</div>}
        {permissions.map(permission => <Approval key={permission.id} permission={permission} control={control}
          onAnswer={action => command(() => state.client.call('task.command', { kind: 'respond', taskId, permissionId: permission.id, behavior: action.behavior, ...(action.id ? { actionId: action.id } : {}) }))} />)}
      </div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {control
      ? <Composer draft={draft} onDraft={setDraft} onSend={() => void send()} onStop={() => void command(() => state.client.call('task.command', { kind: 'stop', taskId }))}
        running={running} busy={sending} disabled={!online || !task || task.status === 'closed'} images={false} />
      : <div className="readonly">{ui('This phone may only read sessions.')}</div>}
  </div>
}
