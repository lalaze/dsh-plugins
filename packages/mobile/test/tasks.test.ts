import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeOffer } from '../src/shared/protocol.js'
import { HubClient, hubFromOffer, nobleX25519 } from '../app/src/hub-client.js'
import { Hub } from '../src/server/hub.js'
import { taskItems, taskPermission, type RemoteTasksService } from '../src/server/tasks.js'
import { FakeHost, FakeRelay, waitFor } from './fakes.js'

type Entry = { seqStart: number; seqEnd: number; timestamp: string; item: Record<string, unknown> & { type: string } }
const entry = (seq: number, item: Entry['item']): Entry => ({ seqStart: seq, seqEnd: seq, timestamp: '2026-11-02T10:00:00.000Z', item })

/** Remote Agents' tasks service over an in-memory history, paged 100 entries at a time as it does. */
function fakeTasks() {
  const task = { id: 'task-1', title: 'Review the API', provider: 'claude', model: 'opus', host: 'mac-mini', cwd: '/srv/app', status: 'running' as const,
    delegated: true, ownerSessionId: 'dsh-1', archived: false, createdAt: '2026-11-02T09:00:00.000Z', updatedAt: '2026-11-02T10:00:00.000Z' }
  const entries: Entry[] = [entry(1, { type: 'user_message', text: 'Conversation context (already occurred; do not repeat completed actions):\nuser: old\n\nCurrent user request:\nReview the API' })]
  for (let i = 0; i < 248; i++) entries.push(entry(entries.length + 1, { type: 'assistant_message', text: 'x' }))
  entries.push(entry(entries.length + 1, { type: 'tool_call', callId: 'c1', name: 'Bash', status: 'running', detail: { command: 'ls' } }))
  entries.push(entry(entries.length + 1, { type: 'tool_call', callId: 'c1', name: 'Bash', status: 'completed', detail: 'listing' }))
  const calls: unknown[] = [], listeners = new Set<() => void>()
  let epoch = 'epoch-1'
  const service: RemoteTasksService & { task: typeof task; entries: Entry[]; calls: unknown[]; changed(): void; replace(): void } = {
    tasksVersion: 1, task, entries, calls,
    list: async () => [structuredClone(task)],
    detail: async (_id, cursor, direction = 'before') => {
      const reset = !!cursor && cursor.epoch !== epoch
      const selected = entries.filter(e => !cursor || reset || (direction === 'after' ? e.seqStart > cursor.seq : e.seqStart < cursor.seq))
      const page = direction === 'after' && !reset ? selected.slice(0, 100) : selected.slice(-100)
      const first = page[0]?.seqStart, last = page.at(-1)?.seqEnd
      return { task: structuredClone(task), permissions: [{ id: 'p1', name: 'Bash', kind: 'tool', title: 'Run ls', input: { command: 'ls' } }],
        timeline: { epoch, entries: page, hasOlder: !!first && first > 1, hasNewer: !!last && last < entries.length,
          startCursor: first ? { epoch, seq: first } : null, endCursor: last ? { epoch, seq: last } : null } }
    },
    send: async (...args) => { calls.push(['send', ...args]) },
    stop: async (...args) => { calls.push(['stop', ...args]) },
    respond: async (...args) => { calls.push(['respond', ...args]) },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    changed: () => { for (const listener of listeners) listener() },
    replace: () => { epoch = 'epoch-2' },
  }
  return service
}

async function phone(t: TestContext, tasks?: () => unknown, grants = { view: true, control: true }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-tasks-'))
  const relay = new FakeRelay(); const address = await relay.listen()
  const hub = await Hub.open({ stateDir: dir, host: new FakeHost(), tasks, version: '0', defaults: { relay: address, appUrl: 'https://phone.example/app/' } })
  t.after(async () => { await hub.close(); await relay.close(); await rm(dir, { recursive: true, force: true }) })
  await hub.start()
  await waitFor(() => hub.status().relay.state === 'online', 5000, 'relay online')
  const { url } = await hub.action({ action: 'offer' }) as { url: string }
  const client = new HubClient(hubFromOffer(decodeOffer(url)), nobleX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array })
  t.after(() => client.close())
  client.connect()
  await waitFor(() => hub.status().requests.length === 1, 5000, 'pairing request')
  await hub.action({ action: 'confirm', requestId: hub.status().requests[0].requestId, grants })
  await waitFor(() => client.info?.phone !== undefined, 5000, 'paired')
  return client
}

test('history entries become phone items: one item per streamed reply, a tool call in its latest state, no prompt framing', () => {
  const items = taskItems([
    entry(1, { type: 'user_message', text: 'Conversation context (already occurred; do not repeat completed actions):\nuser: a\n\nCurrent user request:\nFix it' }),
    entry(2, { type: 'reasoning', text: 'Look' }), entry(3, { type: 'reasoning', text: 'ing' }),
    entry(4, { type: 'assistant_message', text: 'Done ' }), entry(5, { type: 'assistant_message', text: 'now.' }),
    entry(6, { type: 'tool_call', callId: 'c1', name: 'Edit', status: 'running', detail: { path: 'a.ts' } }), entry(7, { type: 'delivery' }),
    entry(8, { type: 'tool_call', callId: 'c1', name: 'Edit', status: 'completed', detail: 'edited' }),
    entry(9, { type: 'error', message: 'boom' }), entry(10, { type: 'interrupted' }), entry(11, { type: 'turn_end', status: 'canceled' }),
  ])
  assert.deepEqual(items.map(item => [item.seq, item.type, item.text, item.status]), [
    [1, 'user', 'Fix it', undefined], [2, 'reasoning', 'Looking', undefined], [4, 'assistant', 'Done now.', undefined],
    [6, 'tool', 'edited', 'completed'], [9, 'error', 'boom', undefined], [10, 'interrupted', undefined, undefined], [11, 'end', undefined, 'canceled'],
  ])
  assert.deepEqual(taskPermission({ id: 'p', name: 'Bash', kind: 'tool', input: { command: 'rm' } }).actions.map(a => a.behavior), ['deny', 'allow'])
  assert.deepEqual(taskPermission({ id: 'q', name: 'Question', kind: 'question' }).actions, [], 'questions are answered on the computer')
})

test('a phone lists background tasks, reads their history in pages, steers them, and hears when the list changes', async t => {
  const service = fakeTasks(), client = await phone(t, () => service)
  const { available, tasks } = await client.call('tasks.list', undefined)
  assert.equal(available, true)
  assert.deepEqual(tasks.map(task => [task.id, task.title, task.status, task.delegated, task.host, task.createdAt]), [['task-1', 'Review the API', 'running', true, 'mac-mini', Date.parse('2026-11-02T09:00:00.000Z')]])

  const latest = await client.call('task.detail', { taskId: 'task-1' })
  assert.equal(latest.page.first, 1, 'several backend pages make one phone page'); assert.equal(latest.page.last, 251); assert.equal(latest.page.hasOlder, false)
  assert.deepEqual(latest.page.items.map(item => [item.type, item.type === 'assistant' ? item.text?.length : item.text]), [['user', 'Review the API'], ['assistant', 248], ['tool', 'listing']])
  assert.deepEqual(latest.permissions, [{ id: 'p1', title: 'Run ls', detail: '{\n  "command": "ls"\n}', actions: [{ id: '', label: 'Deny', behavior: 'deny' }, { id: '', label: 'Allow', behavior: 'allow' }] }])

  service.entries.push(entry(252, { type: 'assistant_message', text: 'More' }))
  const after = await client.call('task.detail', { taskId: 'task-1', after: latest.page.last, epoch: latest.page.epoch })
  assert.deepEqual(after.page.items.map(item => item.text), ['More']); assert.equal(after.page.reset, undefined)
  service.replace()
  const replaced = await client.call('task.detail', { taskId: 'task-1', after: 252, epoch: latest.page.epoch })
  assert.equal(replaced.page.reset, true); assert.equal(replaced.page.epoch, 'epoch-2')

  await client.call('task.command', { kind: 'send', taskId: 'task-1', requestId: 'request-0001', text: ' Also check the docs ' })
  await client.call('task.command', { kind: 'stop', taskId: 'task-1' })
  await client.call('task.command', { kind: 'respond', taskId: 'task-1', permissionId: 'p1', behavior: 'allow' })
  assert.deepEqual(service.calls, [['send', 'task-1', 'request-0001', 'Also check the docs'], ['stop', 'task-1'], ['respond', 'task-1', 'p1', { behavior: 'allow' }]])

  const notices: string[] = []
  client.onNotice(message => { if ('n' in message) notices.push(message.n) })
  service.changed()
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert.deepEqual(notices.filter(n => n === 'tasks'), [], 'a save that changes nothing in the list is not announced')
  service.task.status = 'idle' as never; service.changed()
  await waitFor(() => notices.includes('tasks'), 5000, 'tasks notice')
})

test('without Remote Agents the list is empty and marked unavailable; a read-only phone cannot steer', async t => {
  const missing = await phone(t)
  assert.deepEqual(await missing.call('tasks.list', undefined), { available: false, tasks: [] })
  await assert.rejects(missing.call('task.detail', { taskId: 'task-1' }), /Remote Agents is not installed/)
  const service = fakeTasks(), readOnly = await phone(t, () => service, { view: true, control: false })
  assert.equal((await readOnly.call('task.detail', { taskId: 'task-1' })).task.id, 'task-1')
  await assert.rejects(readOnly.call('task.command', { kind: 'stop', taskId: 'task-1' }), /only read/)
  assert.deepEqual(service.calls, [])
})
