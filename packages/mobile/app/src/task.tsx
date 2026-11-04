/**
 * A background task from Remote Agents: a remote CLI session with no DSH conversation, such as one DSH's agent
 * delegated. Its history follows while the screen is open; it can be steered, stopped and its approvals answered.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskEntry, TaskItem, TaskPage, TaskPermission } from '../../src/shared/protocol.js'
import { JumpToEnd, LoadEarlier, OfflineBanner, Skeleton, Toast, useChatScroll } from './chat.js'
import { Composer, useDraft } from './composer.js'
import { haptic, icons } from './controls.js'
import { errorText, ui } from './i18n.js'
import { requestId } from './parts.js'
import { Approval } from './session.js'
import type { HubState } from './store.js'
import { Text } from './timeline.js'
import { describeTool, jsonArgs, ToolGroup, type ToolCall } from './tools.js'

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

const toolOf = (item: TaskItem): ToolCall => {
  const args = jsonArgs(item.text)
  return {
    id: item.callId ?? String(item.seq), name: item.name ?? ui('Tool'), ...(args ? { args } : { output: item.text }),
    state: item.status === 'running' || item.status === 'pending' ? 'running' : item.status === 'failed' || item.status === 'canceled' ? 'failed' : 'done',
  }
}

/** What an approval would run: the command when its detail is a call's arguments, the detail as it is otherwise. */
function approvalDetail(title: string, detail: string | undefined): string | undefined {
  const args = jsonArgs(detail)
  if (!args) return detail
  const described = describeTool(title, args)
  if (described.kind === 'command') return Array.isArray(args.command) ? args.command.join(' ') : String(args.command ?? args.cmd ?? '')
  return described.target || JSON.stringify(args, null, 2)
}

function Items({ items }: { items: TaskItem[] }) {
  const rows: React.ReactNode[] = []
  let tools: TaskItem[] = []
  const flush = () => { if (tools.length) { rows.push(<ToolGroup key={`tools-${tools[0].seq}`} tools={tools.map(toolOf)} />); tools = [] } }
  for (const item of items) {
    if (item.type === 'tool') { tools.push(item); continue }
    if (item.type === 'reasoning') { if (item.text?.trim()) { flush(); rows.push(<details key={item.seq} className="reasoning"><summary>{icons.sparkle}<span>{ui('Thinking')}</span>{icons.chevronRight}</summary><Text text={item.text} /></details>) } continue }
    flush()
    switch (item.type) {
      case 'user': rows.push(<div key={item.seq} className="msg user"><Text text={item.text ?? ''} /></div>); break
      case 'assistant': if (item.text?.trim()) rows.push(<div key={item.seq} className="msg assistant"><Text text={item.text} /></div>); break
      case 'error': rows.push(<div key={item.seq} className="marker error">{ui('Failed: {0}', { 0: item.text ?? '' })}</div>); break
      case 'interrupted': rows.push(<div key={item.seq} className="marker">{ui('Interrupted')}</div>); break
      case 'model_switch': rows.push(<div key={item.seq} className="marker notice">{ui("{from}'s safeguards stopped this request{category}, so {to} retried it. Later turns in this session stay on {to}.", { from: item.from ?? '', to: item.to ?? '', category: item.category ? ` (${item.category})` : '' })}</div>); break
      case 'end': if (item.status === 'canceled') rows.push(<div key={item.seq} className="marker">{ui('Stopped')}</div>); break
    }
  }
  flush()
  return <>{rows}</>
}

function TaskApproval({ permission, control, onAnswer }: { permission: TaskPermission; control: boolean; onAnswer(action: TaskPermission['actions'][number]): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return <Approval title={ui('Approve {0}?', { 0: permission.title })} text={permission.description} detail={approvalDetail(permission.title, permission.detail)} busy={busy}
    actions={control && permission.actions.length > 0 ? permission.actions.map(action => ({ label: ui(action.label), primary: action.behavior === 'allow', onClick: () => { setBusy(true); haptic(); void onAnswer(action).finally(() => setBusy(false)) } })) : undefined} />
}

export function TaskView({ state, taskId, onBack, onOpenSession }: { state: HubState; taskId: string; onBack(): void; onOpenSession(sessionId: string): void }) {
  const listed = state.tasks.find(task => task.id === taskId)
  const [task, setTask] = useState<TaskEntry | undefined>(listed)
  const [items, setItems] = useState<TaskItem[]>([])
  const [permissions, setPermissions] = useState<TaskPermission[]>([])
  const [page, setPage] = useState<Pick<TaskPage, 'epoch' | 'first' | 'last' | 'hasOlder'>>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useDraft(`${state.hub.hubId}/task/${taskId}`)
  const [sending, setSending] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const scroll = useChatScroll(scroller, content, items.at(-1)?.seq ?? -1)
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

  const earlier = useCallback(async () => {
    if (!page?.first) return
    try {
      const result = await state.client.call('task.detail', { taskId, before: page.first, epoch: page.epoch })
      if (result.page.reset) { setPage(undefined); return }
      scroll.holdPosition()
      setItems(previous => joinItems(result.page.items, previous))
      setPage(previous => previous && { ...previous, first: result.page.first ?? previous.first, hasOlder: result.page.hasOlder })
    } catch (failure) { setError(errorText(failure)) }
  }, [page, scroll, state, taskId])

  const command = async (run: () => Promise<unknown>) => {
    try { await run(); setError(undefined) } catch (failure) { setError(errorText(failure)) }
  }
  const send = async () => {
    const text = draft.text.trim()
    if (!text) return
    setSending(true); scroll.toEnd()
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
      <button className="icon" aria-label={ui('Back')} onClick={onBack}>{icons.back}</button>
      <div className="bar-title">
        <div className="title-line"><span className="ellipsis">{task?.title ?? ui('Background task')}</span></div>
        <div className="subtitle ellipsis">{task && <span className="dot" data-status={task.status === 'attention' ? 'waiting' : running ? 'running' : task.status === 'error' ? 'offline' : 'idle'} />}{subtitle}</div>
      </div>
    </header>
    <OfflineBanner state={state.client.state} error={state.client.error} name={state.hub.name} onRetry={() => state.client.reconnectNow()} />
    <div className="chat-body">
      <div className="scroll chat-scroll" ref={scroller} onScroll={scroll.onScroll}>
        <div className="timeline" ref={content}>
          {task?.delegated && <div className="task-origin">
            {owner ? <button className="link" onClick={() => onOpenSession(owner.sessionId)}>{ui('Delegated from “{0}”', { 0: owner.title || ui('Untitled session') })}</button> : ui('Delegated by DSH')}
            {task.controller && <span> · {ui('In use on {0}', { 0: task.controller })}</span>}
          </div>}
          <LoadEarlier root={scroller} more={page?.hasOlder === true && !loading} onLoad={earlier} />
          {loading && items.length === 0 && <Skeleton />}
          <Items items={items} />
          {task?.status === 'error' && task.error && <div className="marker error">{task.error}</div>}
          {running && permissions.length === 0 && <div className="working"><span className="spinner" />{ui('Working…')}</div>}
        </div>
      </div>
      <JumpToEnd visible={!scroll.atEnd} fresh={scroll.fresh} onClick={() => scroll.toEnd(true)} />
    </div>
    {permissions.length > 0 && <div className="dock">
      {permissions.map(permission => <TaskApproval key={permission.id} permission={permission} control={control}
        onAnswer={action => command(() => state.client.call('task.command', { kind: 'respond', taskId, permissionId: permission.id, behavior: action.behavior, ...(action.id ? { actionId: action.id } : {}) }))} />)}
    </div>}
    <Toast message={error} onClose={() => setError(undefined)} />
    {control
      ? <Composer draft={draft} onDraft={setDraft} onSend={() => void send()} onStop={() => { haptic(); void command(() => state.client.call('task.command', { kind: 'stop', taskId })) }}
        running={running} busy={sending} disabled={!online || !task || task.status === 'closed'} images={false} />
      : <div className="readonly">{ui('This phone may only read sessions.')}</div>}
  </div>
}
