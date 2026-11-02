import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { LiveFrame, MirrorSessionView } from '../src/shared/protocol.js'
import { node, pair, waitFor, type Node } from './fakes.js'

const mirrored = async (n: Node, sessionId: string): Promise<MirrorSessionView | undefined> => (await n.sync.status()).sessions.find(s => s.sessionId === sessionId)
const texts = async (n: Node, deviceId: string, sessionId: string) => {
  const { events } = await n.sync.action({ action: 'events', deviceId, sessionId }) as { events: { type: string; seq: number; data: any }[] }
  return events
}

test('pairing needs both machines to confirm the same code', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  const outgoing = await a.sync.action({ action: 'pair', endpoint: b.endpoint, grants: { history: true, command: false } }) as { pairingId: string; code: string }
  assert.match(outgoing.code, /^\d{6}$/)
  const incoming = (await b.sync.status()).pairings[0]
  assert.equal(incoming.code, outgoing.code)
  assert.equal(incoming.name, 'Laptop')
  // Confirming on one side alone pairs nothing.
  await a.sync.action({ action: 'confirmPairing', pairingId: outgoing.pairingId })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal((await a.sync.status()).peers.length, 0)
  assert.equal((await b.sync.status()).peers.length, 0)
  await b.sync.action({ action: 'confirmPairing', pairingId: incoming.pairingId, grants: { history: true, command: true } })
  await waitFor(async () => (await a.sync.status()).peers.length === 1, 8_000, 'the first side to activate')
  const [peerOnA] = (await a.sync.status()).peers, [peerOnB] = (await b.sync.status()).peers
  assert.equal(peerOnA.name, 'Mac mini'); assert.equal(peerOnB.name, 'Laptop')
  assert.deepEqual(peerOnA.grantsFromPeer, { history: true, command: true }, 'the laptop learns what the Mac mini allows it')
  assert.deepEqual(peerOnB.grantsFromPeer, { history: true, command: false })
  assert.equal(peerOnB.deviceId, a.sync.identity.deviceId)
})

test('a rejected pairing request leaves both machines unpaired', async t => {
  const a = await node(t, 'A'), b = await node(t, 'B')
  const outgoing = await a.sync.action({ action: 'pair', endpoint: b.endpoint, grants: { history: true, command: false } }) as { pairingId: string }
  const incoming = (await b.sync.status()).pairings[0]
  await b.sync.action({ action: 'rejectPairing', pairingId: incoming.pairingId })
  await assert.rejects(a.sync.action({ action: 'confirmPairing', pairingId: outgoing.pairingId }))
  assert.equal((await b.sync.status()).peers.length, 0)
})

test('sessions and workspaces of the executing machine appear on the other, and later events follow without repeats', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addWorkspace('ws-api', 'api')
  b.host.addSession('s1', 'ws-api', 'Fix login')
  b.host.append('s1', 'request/header', { header: { system: 'x'.repeat(1000) } })
  b.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: 'hello' }] })
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => (await mirrored(a, 's1'))?.title === 'Fix login', 8_000, 'the session to arrive')
  const status = await a.sync.status()
  assert.deepEqual(status.workspaces.find(w => w.deviceId === macId)?.items.map(w => w.title), ['api'])
  assert.equal((await mirrored(a, 's1'))?.workspaceId, 'ws-api')
  let events = await texts(a, macId, 's1')
  assert.deepEqual(events.map(e => e.type), ['session/title', 'user/message'], 'request headers stay on their machine')
  b.host.append('s1', 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, stream: ['big'] })
  b.host.emit('s1')
  await waitFor(async () => (await texts(a, macId, 's1')).length === 3, 8_000, 'the new event')
  events = await texts(a, macId, 's1')
  assert.equal(events[2].data.stream, undefined, 'the model stream is not copied')
  // Pull again and again: still each event once.
  for (let i = 0; i < 3; i++) await a.sync.action({ action: 'retry', deviceId: macId })
  assert.deepEqual((await texts(a, macId, 's1')).map(e => e.seq), events.map(e => e.seq))
  // The Mac mini also sees the laptop's (empty) side, so sync is two-way.
  a.host.addSession('l1', undefined, 'Local work')
  await waitFor(async () => (await mirrored(b, 'l1'))?.title === 'Local work', 8_000, 'the reverse direction')
})

test('a prompt from the other machine runs once on the executing machine, however often it is retried', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addWorkspace('ws', 'proj')
  b.host.addSession('s1', 'ws', 'Task')
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  const command = { kind: 'prompt' as const, requestId: 'req-0000001', sessionId: 's1', content: [{ type: 'text' as const, text: 'run tests' }] }
  const results = await Promise.all([1, 2, 3].map(() => a.sync.action({ action: 'command', deviceId: macId, command })))
  assert.deepEqual(results.map(r => (r as { result: unknown }).result), [{ ok: true, sessionId: 's1' }, { ok: true, sessionId: 's1' }, { ok: true, sessionId: 's1' }])
  await a.sync.action({ action: 'command', deviceId: macId, command })
  assert.equal(b.host.prompts.length, 1)
  assert.equal(b.host.prompts[0].requestId, 'req-0000001')
  await waitFor(async () => (await texts(a, macId, 's1')).some(e => e.type === 'assistant/message'), 8_000, 'the reply')
  // Synced events never run anything on the machine that only holds the copy.
  assert.equal(a.host.prompts.length, 0)
  // Nothing is left waiting to send.
  assert.deepEqual((await a.sync.status()).outbox, [])
})

test('remote control needs the executing machine\'s permission', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Task')
  await pair(a, b, { a: { history: true, command: true }, b: { history: true, command: false } })
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  await assert.rejects(a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'cancel', requestId: 'req-cancel-1', sessionId: 's1' } }), /does not allow remote control/)
  assert.deepEqual(b.host.cancels, [])
  await b.sync.action({ action: 'setGrants', deviceId: a.sync.identity.deviceId, grants: { history: true, command: true } })
  await waitFor(async () => (await a.sync.status()).peers[0].grantsFromPeer.command)
  await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'cancel', requestId: 'req-cancel-2', sessionId: 's1' } })
  assert.deepEqual(b.host.cancels, ['s1'])
})

test('a live view streams the assistant draft and the saved events, and stores them', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Live')
  b.host.autoReply = false
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  const abort = new AbortController()
  t.after(() => abort.abort())
  const frames: LiveFrame[] = []
  const reading = (async () => { for await (const frame of a.sync.live(macId, 's1', abort.signal)) frames.push(frame) })().catch(() => {})
  await waitFor(() => frames.some(f => f.type === 'open'))
  await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'prompt', requestId: 'req-live-001', sessionId: 's1', content: [{ type: 'text', text: 'go' }] } })
  b.host.stream('s1', { type: 'start', attemptId: 'at1' })
  b.host.stream('s1', { type: 'chunk', attemptId: 'at1', chunk: { type: 'text-delta', index: 0, text: 'Work' } })
  b.host.stream('s1', { type: 'chunk', attemptId: 'at1', chunk: { type: 'text-delta', index: 0, text: 'ing…' } })
  await waitFor(() => frames.some(f => f.type === 'draft' && f.text === 'Working…'), 8_000, 'the draft')
  b.host.stream('s1', { type: 'end', attemptId: 'at1', outcome: { kind: 'committed' } })
  b.host.finish('s1', 'Done')
  await waitFor(() => frames.some(f => f.type === 'event' && f.event?.type === 'turn/end'), 8_000, 'the end of the turn')
  await waitFor(async () => (await mirrored(a, 's1'))?.state === 'idle')
  const stored = await texts(a, macId, 's1')
  assert.deepEqual(stored.map(e => e.type), ['session/title', 'turn/start', 'user/message', 'assistant/message', 'turn/end'])
  assert.equal(new Set(stored.map(e => e.seq)).size, stored.length)
  abort.abort()
  await reading
})

test('requests to an offline machine wait for confirmation and are never run here', async t => {
  const a = await node(t, 'Laptop')
  let b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Task')
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  const { dir, port } = b
  await b.sync.close()
  await waitFor(async () => (await a.sync.status()).peers[0].connection === 'offline', 10_000, 'the Mac mini to go offline')
  const sent = await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'prompt', requestId: 'req-offline-1', sessionId: 's1', content: [{ type: 'text', text: 'later' }] } }) as { held?: { state: string } }
  assert.equal(sent.held?.state, 'held')
  assert.equal(a.host.prompts.length, 0, 'not run on this machine instead')
  // The Mac mini comes back with its state; the held request stays held until released.
  b = await node(t, 'Mac mini', { dir, port })
  b.host.addSession('s1', undefined, 'Task')
  await waitFor(async () => (await a.sync.status()).peers[0].connection === 'online', 15_000, 'the Mac mini to return')
  assert.equal((await a.sync.status()).outbox.length, 1)
  assert.equal(b.host.prompts.length, 0)
  await a.sync.action({ action: 'release', requestId: 'req-offline-1' })
  assert.equal(b.host.prompts.length, 1)
  assert.deepEqual((await a.sync.status()).outbox, [])
})

test('a machine that was off catches up on what changed meanwhile', async t => {
  let a = await node(t, 'Laptop')
  const b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Before')
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  const { dir, port } = a
  await a.sync.close()
  b.host.addSession('s2', undefined, 'While away')
  b.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: 'from the phone' }] })
  b.host.emit('s1')
  a = await node(t, 'Laptop', { dir, port })
  await waitFor(async () => (await mirrored(a, 's2'))?.title === 'While away', 10_000, 'the new session')
  await waitFor(async () => (await texts(a, macId, 's1')).some(e => e.type === 'user/message'), 10_000, 'the new message')
})

test('unpairing stops both machines from syncing or sending requests', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Task')
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  await b.sync.action({ action: 'unpair', deviceId: a.sync.identity.deviceId })
  await waitFor(async () => (await a.sync.status()).peers[0].connection === 'unpaired', 8_000, 'the laptop to learn it was unpaired')
  await assert.rejects(a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'cancel', requestId: 'req-after-unpair', sessionId: 's1' } }), /no longer paired/)
  assert.deepEqual(b.host.cancels, [])
  // The copy stays readable here until the user forgets it.
  assert.ok(await mirrored(a, 's1'))
  await a.sync.action({ action: 'unpair', deviceId: macId, forgetHistory: true })
  assert.equal(await mirrored(a, 's1'), undefined)
})

test('groups edited on either machine reach the other, with a backup before the first sync', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  a.host.addWorkspace('wa', 'site')
  a.tags.edit(s => { s.tags.push({ id: 't-work', name: 'Work', color: 'blue' }); s.assignments.wa = ['t-work'] })
  b.tags.edit(s => { s.tags.push({ id: 't-home', name: 'Home', color: 'green' }) })
  await pair(a, b)
  await waitFor(() => b.tags.state.tags.length === 2 && a.tags.state.tags.length === 2, 8_000, 'both groups on both machines')
  assert.deepEqual(b.tags.state.tags.map(t => t.name).sort(), ['Home', 'Work'])
  assert.deepEqual(b.tags.state.assignments, {}, 'the laptop\'s workspace assignments are not written into the Mac mini\'s sidebar')
  const viewOnB = (await b.sync.status()).groups
  assert.deepEqual(viewOnB.assignments[`${a.sync.identity.deviceId}:wa`], ['t-work'])
  // Rename on the Mac mini; the laptop follows within the 5-second target.
  const started = Date.now()
  b.tags.edit(s => { s.tags.find(t => t.id === 't-work')!.name = 'Clients' })
  await waitFor(() => a.tags.state.tags.some(t => t.name === 'Clients'), 5_000, 'the rename')
  assert.ok(Date.now() - started < 5_000)
  assert.equal((await readdir(join(a.dir, 'backups'))).length, 1)
})

test('a group set here on the other machine\'s workspace reaches its sidebar, only while this machine shares with it', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addWorkspace('wb', 'zebox')
  a.tags.edit(s => { s.tags.push({ id: 't-work', name: 'Work', color: 'blue' }) })
  await pair(a, b)
  const macId = b.sync.identity.deviceId, ref = `${macId}:wb`
  await waitFor(async () => b.tags.state.tags.length === 1 && (await a.sync.status()).workspaces.some(w => w.deviceId === macId && w.items.length), 8_000, 'tag and workspace synced')
  await a.sync.action({ action: 'assign', workspaceRef: ref, tagId: 't-work', assigned: true })
  await waitFor(() => (b.tags.state.assignments.wb ?? []).includes('t-work'), 5_000, 'the assignment in the Mac mini sidebar')
  await assert.rejects(a.sync.action({ action: 'assign', workspaceRef: `${macId}:missing`, tagId: 't-work', assigned: true }), /Unknown workspace/)
  // Without sharing, the Mac mini cannot pull the change, so it is refused instead of silently kept here.
  await a.sync.action({ action: 'setGrants', deviceId: macId, grants: { history: false, command: false } })
  await assert.rejects(a.sync.action({ action: 'assign', workspaceRef: ref, tagId: 't-work', assigned: false }), /does not share with Mac mini/)
  assert.deepEqual((await a.sync.status()).groups.assignments[ref], ['t-work'])
  // Nor after unpairing, while the copied history stays.
  await a.sync.action({ action: 'unpair', deviceId: macId, forgetHistory: false })
  await assert.rejects(a.sync.action({ action: 'assign', workspaceRef: ref, tagId: 't-work', assigned: false }), /only be changed on paired machines/)
})

test('confirmations waiting on the executing machine can be answered from the other one', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Task')
  b.host.autoReply = false
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'prompt', requestId: 'req-approve-1', sessionId: 's1', content: [{ type: 'text', text: 'deploy' }] } })
  // DSH asks for an approval; the bridge offers it to the paired machine.
  const withdraw = new AbortController()
  const offered = b.host.bridge!({ sessionId: 's1', toolName: 'bash', callId: 'call-1', reason: 'rm -rf build' }, withdraw.signal)!
  await waitFor(async () => (await mirrored(a, 's1'))?.state === 'waiting', 8_000, 'the waiting state')
  const pending = (await mirrored(a, 's1'))!.pending[0]
  assert.equal(pending.kind, 'approval')
  assert.ok(pending.kind === 'approval' && pending.answerable && pending.toolName === 'bash')
  await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'approval', requestId: 'req-approve-2', sessionId: 's1', approvalId: pending.id, outcome: 'allowed-once' } })
  assert.equal(await offered.answer, 'allowed-once')
  withdraw.abort()
  // An open question is answered through DSH's question service.
  b.host.ask('s1', [{ callId: 'q-call', state: 'open', questions: [{ id: 'q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }])
  await waitFor(async () => (await mirrored(a, 's1'))?.pending.some(p => p.kind === 'question') ?? false, 8_000, 'the question')
  await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'answer', requestId: 'req-answer-1', sessionId: 's1', callId: 'q-call', answers: [{ id: 'q1', selected: ['dev'] }] } })
  assert.deepEqual(b.host.answers, [{ sessionId: 's1', callId: 'q-call', answers: [{ id: 'q1', selected: ['dev'] }] }])
})

test('a new session can be started on the other machine, linked to the one it carries on', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addWorkspace('ws', 'proj')
  a.host.addSession('local-1', undefined, 'Started here')
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => (await a.sync.status()).workspaces.some(w => w.deviceId === macId && w.items.length === 1))
  const sent = await a.sync.action({ action: 'command', deviceId: macId, command: { kind: 'create', requestId: 'req-create-1', workspaceId: 'ws',
    content: [{ type: 'text', text: 'Continue the login fix' }], continuedFrom: { deviceId: a.sync.identity.deviceId, sessionId: 'local-1' } } }) as { result: { sessionId: string } }
  const created = sent.result.sessionId
  assert.deepEqual(b.host.prompts.map(p => p.text), ['Continue the login fix'])
  await waitFor(async () => (await mirrored(a, created))?.continuedFrom?.sessionId === 'local-1', 8_000, 'the linked session')
  assert.equal((await mirrored(a, created))?.workspaceId, 'ws')
})

test('images arrive with their session and are stored once by content', async t => {
  const a = await node(t, 'Laptop'), b = await node(t, 'Mac mini')
  b.host.addSession('s1', undefined, 'Pictures')
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
  b.host.images.set('img-1', png); b.host.images.set('img-2', png)
  for (const id of ['img-1', 'img-2']) {
    b.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } }] })
  }
  await pair(a, b)
  const macId = b.sync.identity.deviceId
  await waitFor(async () => Boolean(await mirrored(a, 's1')))
  await waitFor(async () => (await texts(a, macId, 's1')).length === 3, 8_000, 'the messages')
  const image = await a.sync.attachment(macId, 's1', 'img-2')
  assert.deepEqual(new Uint8Array(image.data), png)
  assert.equal(image.mediaType, 'image/png')
  assert.equal((await readdir(join(a.dir, 'blobs'))).length, 1)
  // An attachment the session never showed is not served.
  await assert.rejects(a.sync.attachment(macId, 's1', 'img-3'), /Unknown attachment/)
})
