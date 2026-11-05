import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeOffer, type LiveFrame, type SessionEntry, type TagState } from '../src/shared/protocol.js'
import { HubClient, hubFromOffer, nobleX25519 } from '../app/src/hub-client.js'
import { addToDraft, type ReplyDraft } from '../src/server/bridge/events.js'
import { Hub } from '../src/server/hub.js'
import { FakeHost, FakeRelay, startHub, waitFor, type TestHub } from './fakes.js'

const requestId = () => `req-${Math.random().toString(36).slice(2, 12)}`

async function pairedPhone(t: TestContext, setup: TestHub, grants = { view: true, control: true }) {
  const { url } = await setup.hub.action({ action: 'offer' }) as { url: string }
  assert.match(url, /^https:\/\/phone\.example\/app\/#pair=/)
  const saved = hubFromOffer(decodeOffer(url))
  const client = new HubClient(saved, nobleX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array })
  t.after(() => client.close())
  client.connect()
  await waitFor(() => setup.hub.status().requests.length === 1, 5000, 'pairing request')
  const request = setup.hub.status().requests[0]
  await waitFor(() => client.info?.pairing?.code === request.code, 5000, 'same code on the phone')
  await setup.hub.action({ action: 'confirm', requestId: request.requestId, grants })
  await waitFor(() => client.info?.phone !== undefined, 5000, 'paired')
  assert.equal(saved.token, undefined, 'the one-time token is dropped once paired')
  return { client, saved }
}

test('a phone pairs through the relay once the computer confirms the matching code', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('s1', 'w1', 'First task')
  const { client } = await pairedPhone(t, setup)
  assert.equal(client.state, 'online')
  assert.equal(setup.hub.status().phones.length, 1)
  assert.equal(setup.hub.status().phones[0].online, true)

  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.some(s => s.sessionId === 's1'), 5000, 'session listed')
  const changes = await client.call('sessions.changes', {})
  assert.equal(changes.sessions.find(s => s.sessionId === 's1')?.title, 'First task')
  assert.equal(changes.workspaces?.[0].title, 'project')
  // A cursor returns only what changed since.
  assert.equal((await client.call('sessions.changes', { since: changes.cursor })).sessions.length, 0)
})

test('the pairing code works once and only for its own phone', async t => {
  const setup = await startHub(t)
  const { url } = await setup.hub.action({ action: 'offer' }) as { url: string }
  const first = new HubClient(hubFromOffer(decodeOffer(url)), nobleX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array })
  const second = new HubClient(hubFromOffer(decodeOffer(url)), nobleX25519.generate() as { secretKey: Uint8Array; publicKey: Uint8Array })
  t.after(() => { first.close(); second.close() })
  first.connect()
  await waitFor(() => first.info?.pairing !== undefined, 5000, 'first request')
  second.connect()
  await waitFor(() => second.state === 'offline' || second.state === 'unpaired', 5000, 'second refused')
  assert.equal(setup.hub.status().requests.length, 1)
  // A phone that is not paired reads nothing.
  await assert.rejects(first.call('sessions.changes', {}), /not paired/)
  await setup.hub.action({ action: 'reject', requestId: setup.hub.status().requests[0].requestId })
  await waitFor(() => first.state === 'unpaired', 5000, 'declined')
  assert.equal(setup.hub.status().phones.length, 0)
})

test('a phone reads a conversation from its end, sends a message, follows it live and stops a task', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('s1', 'w1', 'Chat')
  for (let i = 0; i < 30; i++) setup.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: `old ${i}` }] })
  const { client } = await pairedPhone(t, setup)
  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.some(s => s.sessionId === 's1'), 5000, 'listed')

  const tail = await client.call('session.events', { sessionId: 's1', limit: 10 })
  assert.equal(tail.events.length, 10)
  assert.equal(tail.hasEarlier, true)
  assert.equal(tail.events.at(-1)!.seq, tail.lastSeq)
  const earlier = await client.call('session.events', { sessionId: 's1', before: tail.events[0].seq, limit: 100 })
  assert.equal(earlier.events.at(-1)!.seq, tail.events[0].seq - 1)
  assert.equal(earlier.hasEarlier, false)

  const frames: LiveFrame[] = []
  const live = client.follow('session.live', { sessionId: 's1' }, frame => frames.push(frame as LiveFrame))
  t.after(() => live.close())
  await waitFor(() => frames.some(f => f.type === 'open'), 5000, 'live open')

  const id = requestId()
  await client.call('command', { kind: 'prompt', requestId: id, sessionId: 's1', content: [{ type: 'text', text: 'hello' }] })
  // A retry with the same ID does not send twice.
  await client.call('command', { kind: 'prompt', requestId: id, sessionId: 's1', content: [{ type: 'text', text: 'hello' }] })
  assert.equal(setup.host.prompts.filter(p => p.text === 'hello').length, 1)
  await waitFor(() => frames.some(f => f.type === 'event' && f.event?.type === 'assistant/message'), 5000, 'reply streamed')

  setup.host.autoReply = false
  await client.call('command', { kind: 'prompt', requestId: requestId(), sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'change course' }] })
  assert.equal(setup.host.prompts.at(-1)!.mode, 'steer')
  await client.call('command', { kind: 'cancel', requestId: requestId(), sessionId: 's1' })
  assert.deepEqual(setup.host.cancels, ['s1'])
})

test('a phone that opens during a reply gets what was written so far, then follows it', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('s1', 'w1', 'Chat')
  const { client } = await pairedPhone(t, setup)
  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.some(s => s.sessionId === 's1'), 5000, 'listed')
  // The compact form DSH keeps of a reply in progress: two blocks of text, with thinking after them.
  setup.host.activeAttempts.set('s1', { attemptId: 'a1', stream: [
    { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['First ', 'part.'] },
    { type: 'chunk', time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'First part.' } } },
    { type: 'chunk', time: 4, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
    { type: 'text-chunks', time0: 4, index: 1, dt: [], texts: ['Second.'] },
    { type: 'chunk', time: 5, chunk: { type: 'block-start', index: 2, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 5, index: 2, dt: [], texts: ['Checking the build.'] },
  ] })
  const frames: LiveFrame[] = []
  const live = client.follow('session.live', { sessionId: 's1' }, frame => frames.push(frame as LiveFrame))
  t.after(() => live.close())
  const drafts = () => frames.filter((frame): frame is Extract<LiveFrame, { type: 'draft' }> => frame.type === 'draft')
  await waitFor(() => drafts().length > 0, 5000, 'the reply so far')
  assert.equal(drafts()[0].text, 'First part.\n\nSecond.')
  assert.equal(drafts()[0].reasoning, 'Checking the build.')

  // Text after thinking ends what the phone shows of that thinking.
  setup.host.stream('s1', { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', index: 3, text: ' Third.' } })
  await waitFor(() => drafts().at(-1)!.text.endsWith('Third.'), 5000, 'the next words')
  assert.equal(drafts().at(-1)!.reasoning, '')
  setup.host.stream('s1', { type: 'end', attemptId: 'a1' })
  await waitFor(() => drafts().at(-1)!.done === true, 5000, 'the end of the reply')
})

test('a reply with nothing to read yet sends the phone nothing', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('s1', 'w1', 'Chat')
  const { client } = await pairedPhone(t, setup)
  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.some(s => s.sessionId === 's1'), 5000, 'listed')
  const frames: LiveFrame[] = []
  const live = client.follow('session.live', { sessionId: 's1' }, frame => frames.push(frame as LiveFrame))
  t.after(() => live.close())
  await waitFor(() => frames.some(frame => frame.type === 'open'), 5000, 'live open')
  setup.host.stream('s1', { type: 'start', attemptId: 'a1' })
  setup.host.stream('s1', { type: 'chunk', attemptId: 'a1', chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  setup.host.stream('s1', { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', index: 0, text: 'Hello' } })
  await waitFor(() => frames.some(frame => frame.type === 'draft'), 5000, 'the first words')
  assert.deepEqual(frames.filter(frame => frame.type === 'draft').map(frame => (frame as { text: string }).text), ['Hello'])
})

test('a phone starts a session with a model and permission, renames and archives it', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  const { client } = await pairedPhone(t, setup)
  const choices = await client.call('models', {})
  assert.equal(choices.groups[0].models[0].id, 'chat')
  const model = { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }
  const created = await client.call('command', { kind: 'create', requestId: requestId(), workspaceId: 'w1', model, permission: 'workspace-write', content: [{ type: 'text', text: 'start here' }] })
  assert.ok(created.sessionId)
  assert.deepEqual(setup.host.created, [{ workspaceId: 'w1', permission: 'workspace-write' }])
  assert.deepEqual(setup.host.selections, [{ sessionId: created.sessionId, model }])
  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.find(s => s.sessionId === created.sessionId)?.model?.model === 'chat', 5000, 'model shown')

  await client.call('command', { kind: 'rename', requestId: requestId(), sessionId: created.sessionId!, title: 'Renamed' })
  await client.call('command', { kind: 'archive', requestId: requestId(), sessionId: created.sessionId!, archived: true })
  await waitFor(async () => {
    const entry = (await client.call('sessions.changes', {})).sessions.find(s => s.sessionId === created.sessionId)
    return entry?.title === 'Renamed' && entry.archived
  }, 5000, 'renamed and archived')
})

test('a phone answers an approval DSH asks, and a read-only phone cannot', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  const session = setup.host.addSession('s1', 'w1', 'Needs approval')
  const { client } = await pairedPhone(t, setup)
  session.running = true
  setup.host.emit('s1')
  const asked = setup.host.bridge!({ sessionId: 's1', toolName: 'bash', callId: 'c1', reason: 'rm -rf build' }, new AbortController().signal)!
  assert.ok(asked, 'a phone allowed to control is online, so DSH asks it too')
  let entry: SessionEntry | undefined
  await waitFor(async () => {
    entry = (await client.call('sessions.changes', {})).sessions.find(s => s.sessionId === 's1')
    return entry?.state === 'waiting'
  }, 5000, 'waiting')
  const approval = entry!.pending.find(p => p.kind === 'approval')!
  assert.equal(approval.kind === 'approval' && approval.reason, 'rm -rf build')
  await client.call('command', { kind: 'approval', requestId: requestId(), sessionId: 's1', approvalId: approval.id, outcome: 'allowed-once' })
  assert.equal(await asked.answer, 'allowed-once')
  // Withdrawn at once, before DSH's own chain finishes, so it cannot be answered twice.
  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.find(s => s.sessionId === 's1')?.pending.length === 0, 5000, 'approval withdrawn')
  await assert.rejects(client.call('command', { kind: 'approval', requestId: requestId(), sessionId: 's1', approvalId: approval.id, outcome: 'rejected' }), /no longer pending/)

  const phoneId = setup.hub.status().phones[0].id
  await setup.hub.action({ action: 'grants', phoneId, grants: { view: true, control: false } })
  await assert.rejects(client.call('command', { kind: 'cancel', requestId: requestId(), sessionId: 's1' }), /only read/)
  assert.equal(setup.host.bridge!({ sessionId: 's1', toolName: 'bash' }, new AbortController().signal), undefined, 'no phone may answer now')
})

test('unpairing on the computer disconnects the phone and refuses it afterwards', async t => {
  const setup = await startHub(t)
  const { client, saved } = await pairedPhone(t, setup)
  await setup.hub.action({ action: 'unpair', phoneId: setup.hub.status().phones[0].id })
  await waitFor(() => client.state === 'unpaired', 5000, 'unpaired')
  const again = new HubClient(saved, (client as unknown as { identity: { secretKey: Uint8Array; publicKey: Uint8Array } }).identity)
  t.after(() => again.close())
  again.connect()
  await waitFor(() => again.state === 'unpaired', 5000, 'still refused')
})

test('the phone reconnects by itself after the relay drops it, and live streams resume', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('s1', 'w1', 'Chat')
  const { client } = await pairedPhone(t, setup)
  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.length === 1, 5000, 'listed')
  let opens = 0, restarts = 0
  const live = client.follow('session.live', { sessionId: 's1' }, frame => { if ((frame as LiveFrame).type === 'open') opens++ }, () => { restarts++ })
  t.after(() => live.close())
  await waitFor(() => opens === 1, 5000, 'first open')
  setup.relay.dropPhones()
  await waitFor(() => client.state !== 'online', 5000, 'dropped')
  await waitFor(() => client.state === 'online' && opens === 2, 10_000, 'reconnected and reopened')
  assert.equal(restarts, 1)
})

test('a relay that refuses this machine is reported with the server ID to allow', async t => {
  const setup = await startHub(t)
  setup.relay.allow = id => id === 'srv_someone_else'
  // Reconnect with the new rule in force.
  await setup.hub.action({ action: 'settings', relay: `ws://127.0.0.1:${setup.relay.port}/` })
  await setup.hub.action({ action: 'settings', relay: `ws://localhost:${setup.relay.port}` })
  await waitFor(() => setup.hub.status().relay.state === 'offline', 8000, 'offline')
  const status = setup.hub.status()
  assert.match(status.relay.error ?? '', /refused this machine \(HTTP 403\)/)
  assert.ok(status.relay.error?.includes(status.hubId))
})

test('notifications reach a subscribed phone encrypted, when a task finishes or waits for an answer', async t => {
  const sent: { endpoint: string; headers: Headers; body: Uint8Array }[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://push.example/')) { sent.push({ endpoint: url, headers: new Headers(init?.headers), body: new Uint8Array(init!.body as Uint8Array) }); return new Response(null, { status: 201 }) }
    return fetch(input, init)
  }) as typeof fetch
  const setup = await startHub(t, { fetch: fakeFetch })
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('s1', 'w1', 'Long task')
  const { client } = await pairedPhone(t, setup)
  // The phone's browser keys, as PushManager would make them.
  const browser = createECDH('prime256v1'); browser.generateKeys()
  const auth = Buffer.from('0123456789abcdef')
  await client.call('push.subscribe', { subscription: { endpoint: 'https://push.example/sub/1', keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, preferences: { finished: true, attention: true } })
  assert.equal(setup.hub.status().phones[0].push, true)

  await waitFor(async () => (await client.call('sessions.changes', {})).sessions.length === 1, 5000, 'listed')
  await client.call('command', { kind: 'prompt', requestId: requestId(), sessionId: 's1', content: [{ type: 'text', text: 'work' }] })
  await waitFor(() => sent.length >= 1, 8000, 'finished notification')
  const message = decryptPush(sent[0].body, browser, auth) as { title: string; body: string; sessionId: string; hubId: string }
  assert.equal(message.title, 'Long task')
  assert.equal(message.body, 'Reply to work')
  assert.equal(message.sessionId, 's1')
  assert.equal(message.hubId, setup.hub.status().hubId)
  assert.match(sent[0].headers.get('authorization') ?? '', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
  assert.equal(sent[0].headers.get('content-encoding'), 'aes128gcm')
})

test('state survives a restart: the same machine ID and paired phones', async t => {
  const setup = await startHub(t)
  await pairedPhone(t, setup)
  const before = setup.hub.status()
  await setup.hub.close()
  const reopened = await Hub.open({ stateDir: setup.dir, host: setup.host, version: '0' })
  const after = reopened.status()
  assert.equal(after.hubId, before.hubId)
  assert.equal(after.phones.length, 1)
  await reopened.close()
})

/** RFC 8291 decryption, as the phone's browser does it. */
function decryptPush(body: Uint8Array, browser: ReturnType<typeof createECDH>, auth: Buffer): unknown {
  const buffer = Buffer.from(body)
  const salt = buffer.subarray(0, 16), idLength = buffer[20], serverKey = buffer.subarray(21, 21 + idLength), ciphertext = buffer.subarray(21 + idLength)
  const shared = browser.computeSecret(serverKey)
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), serverKey]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter')
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'))
}

test('a phone sees sessions as DSH shows them: first message as title, injected context left out, blanks marked', async t => {
  const setup = await startHub(t)
  setup.host.addWorkspace('w1', 'project')
  setup.host.addSession('blank', 'w1')
  setup.host.addSession('s1', 'w1')
  setup.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: 'Fix the login redirect' }], source: { kind: 'user' } })
  setup.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: '<system-reminder>skills…</system-reminder>' }], source: { kind: 'skill-catalog', form: 'catalog' } })
  setup.host.append('s1', 'user/message', { role: 'user', content: [{ type: 'text', text: 'Time sampled…' }], source: { kind: 'time-context', form: 'snapshot' } })
  setup.host.append('s1', 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], source: { kind: 'model', provider: 'p', model: 'm', replayState: { big: 'x'.repeat(1000) } } } })
  const { client } = await pairedPhone(t, setup)
  let sessions: SessionEntry[] = []
  await waitFor(async () => { sessions = (await client.call('sessions.changes', {})).sessions; return sessions.length === 2 }, 5000, 'listed')
  assert.equal(sessions.find(s => s.sessionId === 's1')?.title, 'Fix the login redirect')
  assert.equal(sessions.find(s => s.sessionId === 'blank')?.blank, true)
  assert.equal(sessions.find(s => s.sessionId === 's1')?.blank, undefined)
  const { events } = await client.call('session.events', { sessionId: 's1', limit: 50 })
  assert.deepEqual(events.filter(e => e.type === 'user/message').map(e => (e.data as { content: { text: string }[] }).content[0].text), ['Fix the login redirect'])
  const source = (events.find(e => e.type === 'assistant/message')!.data as { message: { source: Record<string, unknown> } }).message.source
  assert.deepEqual(source, { kind: 'model', provider: 'p', model: 'm' })
  // A session that never chose a model shows the one that wrote its latest reply.
  assert.deepEqual(sessions.find(s => s.sessionId === 's1')?.model, { provider: 'p', model: 'm' })
})

test('a phone reads Workspace Tags through the hub, and hears when they change', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-tags-'))
  const relay = new FakeRelay(); const address = await relay.listen()
  const host = new FakeHost()
  let state: TagState = { tags: [{ id: 't1', name: 'Work', color: 'green' }], assignments: { w1: ['t1'] } }
  const listeners = new Set<(next: TagState) => void>()
  const tags = { snapshot: () => state, subscribe: (listener: (next: TagState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const hub = await Hub.open({ stateDir: dir, host, tags: () => tags, version: '0', defaults: { relay: address, appUrl: 'https://phone.example/app/' } })
  t.after(async () => { await hub.close(); await relay.close(); await rm(dir, { recursive: true, force: true }) })
  await hub.start()
  await waitFor(() => hub.status().relay.state === 'online', 5000, 'relay online')
  host.addWorkspace('w1', 'project')
  const { client } = await pairedPhone(t, { hub, host, relay, dir })
  assert.deepEqual(await client.call('tags', undefined), state)
  const notices: string[] = []
  client.onNotice(message => { if ('n' in message) notices.push(message.n) })
  state = { tags: [...state.tags, { id: 't2', name: 'Home', color: 'blue' }], assignments: { w1: ['t1', 't2'] } }
  for (const listener of listeners) listener(state)
  await waitFor(() => notices.includes('changed'), 5000, 'change notice')
  assert.equal((await client.call('tags', undefined)).tags.length, 2)
})

test('facts cached by an older version are read again on start', async t => {
  const setup = await startHub(t)
  setup.hub.state.executor.sessions['old'] = { updatedAt: 1, running: false, lastSeq: 0 }
  delete setup.hub.state.executor.version
  await setup.hub.store.flush()
  await setup.hub.close()
  const reopened = await Hub.open({ stateDir: setup.dir, host: setup.host, version: '0' })
  assert.equal(reopened.state.executor.sessions['old'], undefined)
  assert.equal(reopened.state.executor.version, 2)
  await reopened.close()
})

test('a line a remote CLI shows after a closed block leaves the phone when that block closes again', () => {
  const draft: ReplyDraft = { text: '', reasoning: '' }
  const add = (...chunks: unknown[]) => { for (const chunk of chunks) addToDraft(draft, chunk) }
  // Nothing written yet: the line has a block of its own.
  add({ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text: '' } })
  assert.equal(draft.text, '')
  add({ type: 'text-delta', index: 0, text: '> Running Bash' })
  assert.equal(draft.text, '> Running Bash')
  add({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
  assert.equal(draft.text, '')
  add({ type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: 'Looking.' }, { type: 'block-end', index: 1, block: { type: 'text', text: 'Looking.' } })
  add({ type: 'text-delta', index: 1, text: '\n\n> Running Read' })
  assert.equal(draft.text, 'Looking.\n\n> Running Read')
  add({ type: 'block-end', index: 1, block: { type: 'text', text: 'Looking.' } }, { type: 'text-delta', index: 1, text: '\n\n> Running Grep' })
  assert.equal(draft.text, 'Looking.\n\n> Running Grep')
  // The compact form DSH keeps replays the same way, for a phone that opens now.
  const reopened: ReplyDraft = { text: '', reasoning: '' }
  for (const record of [{ type: 'text-chunks', index: 1, texts: ['Looking.', ' More.'] }, { type: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'Looking. More.' } } }, { type: 'text-chunks', index: 1, texts: ['\n\n> Running Read'] }, { type: 'chunk', chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'Looking. More.' } } }]) addToDraft(reopened, record)
  assert.equal(reopened.text, 'Looking. More.')
})
