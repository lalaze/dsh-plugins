import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { openApprovals, openQuestions, shareEvent } from '../src/server/events.js'
import { Groups, emptyGroups, linkKey } from '../src/server/groups.js'
import { bridgeApprovalEvent } from '../src/server/host.js'
import { deviceIdOf, loadIdentity, pairingCode, requestCanonical, sha256 } from '../src/server/identity.js'
import { Blobs, Mirror } from '../src/server/mirror.js'
import { createPeerServer, isTailnetOrLoopback, PeerError, signedFetch, HEADER } from '../src/server/transport.js'

const tempDir = async (t: test.TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'device-sync-unit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('the identity is created once, and its device ID comes from its key', async t => {
  const dir = await tempDir(t)
  const first = await loadIdentity(join(dir, 'identity.json')), again = await loadIdentity(join(dir, 'identity.json'))
  assert.equal(first.deviceId, again.deviceId)
  assert.equal(first.deviceId, deviceIdOf(first.publicKey))
  const other = await loadIdentity(join(dir, 'other.json'))
  assert.notEqual(other.deviceId, first.deviceId)
  // Both sides compute the same code from their own view of the exchange.
  assert.equal(pairingCode(first.publicKey, other.publicKey, 'n1', 'n2'), pairingCode(other.publicKey, first.publicKey, 'n2', 'n1'))
  assert.notEqual(pairingCode(first.publicKey, other.publicKey, 'n1', 'n2'), pairingCode(first.publicKey, other.publicKey, 'n1', 'n3'))
})

test('the peer listener accepts only signed, fresh requests from paired keys, and signs its answers', async t => {
  const dir = await tempDir(t)
  const server = await loadIdentity(join(dir, 'server.json')), client = await loadIdentity(join(dir, 'client.json')), stranger = await loadIdentity(join(dir, 'x.json'))
  const listener = createPeerServer({ identity: server, keyFor: id => (id === client.deviceId ? client.publicKey : undefined), handle: async r => ({ status: 200, json: { from: r.from, body: r.body } }) })
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => listener.close(() => resolve())))
  const endpoint = `127.0.0.1:${(listener.address() as { port: number }).port}`
  const ok = await signedFetch(client, endpoint, { method: 'POST', path: '/v1/x', body: { a: 1 }, to: server.deviceId }, server.publicKey)
  assert.deepEqual(ok.body, { from: client.deviceId, body: { a: 1 } })
  await assert.rejects(signedFetch(stranger, endpoint, { method: 'GET', path: '/v1/x', to: server.deviceId }, server.publicKey), (e: PeerError) => e.status === 401)
  await assert.rejects(signedFetch(client, endpoint, { method: 'GET', path: '/v1/x', to: 'someone-else' }, server.publicKey), (e: PeerError) => e.status === 409)
  // An answer signed by another key is refused, even when the request went through.
  await assert.rejects(signedFetch(client, endpoint, { method: 'GET', path: '/v1/x', to: server.deviceId }, stranger.publicKey), /not signed by the paired device/)
  // A replayed request is refused.
  const time = String(Date.now()), id = 'replay-nonce-0123456789'
  const headers = { [HEADER.from]: client.deviceId, [HEADER.to]: server.deviceId, [HEADER.time]: time, [HEADER.nonce]: id,
    [HEADER.signature]: client.sign(requestCanonical('GET', '/v1/x', client.deviceId, server.deviceId, time, id, sha256(''))) }
  assert.equal((await fetch(`http://${endpoint}/v1/x`, { headers })).status, 200)
  assert.equal((await fetch(`http://${endpoint}/v1/x`, { headers })).status, 401)
  // A tampered body breaks the signature.
  const tampered = { ...headers, [HEADER.nonce]: 'tampered-nonce-0123456', [HEADER.signature]: client.sign(requestCanonical('POST', '/v1/x', client.deviceId, server.deviceId, time, 'tampered-nonce-0123456', sha256('{"a":1}'))) }
  assert.equal((await fetch(`http://${endpoint}/v1/x`, { method: 'POST', headers: tampered, body: '{"a":2}' })).status, 401)
})

test('only Tailscale and loopback addresses reach the listener by default', () => {
  for (const address of ['100.96.195.115', '::ffff:100.64.0.1', '100.127.255.255', '127.0.0.1', '::1', 'fd7a:115c:a1e0::1']) assert.ok(isTailnetOrLoopback(address), address)
  for (const address of ['192.168.1.10', '100.128.0.1', '100.63.255.255', '10.0.0.1', '2001:db8::1']) assert.ok(!isTailnetOrLoopback(address), address)
})

test('groups merge field by field, and concurrent edits keep both values', () => {
  const laptop = new Groups(emptyGroups(), 'laptop'), mini = new Groups(emptyGroups(), 'mini')
  laptop.observeLocal({ tags: [{ id: 't1', name: 'Work', color: 'blue' }], assignments: { w1: ['t1'] } })
  mini.merge('laptop', laptop.registers()); laptop.merge('mini', mini.registers())
  assert.deepEqual(mini.tags().map(t => t.name), ['Work'])
  assert.deepEqual(mini.assignments(), { 'laptop:w1': ['t1'] })
  assert.deepEqual(mini.project(), { tags: [{ id: 't1', name: 'Work', color: 'blue' }], assignments: {} })
  // Different fields: both survive, no conflict.
  laptop.observeLocal({ tags: [{ id: 't1', name: 'Clients', color: 'blue' }], assignments: { w1: ['t1'] } })
  mini.projected(mini.project())
  mini.observeLocal({ tags: [{ id: 't1', name: 'Work', color: 'red' }], assignments: {} })
  mini.merge('laptop', laptop.registers()); laptop.merge('mini', mini.registers())
  assert.deepEqual(laptop.tags(), mini.tags())
  assert.deepEqual(mini.tags().map(t => [t.name, t.color]), [['Clients', 'red']])
  assert.equal(mini.view(true).conflicts.length, 0)
  // Same field on both: the later write wins on both machines, and the other value is kept.
  laptop.observeLocal({ tags: [{ id: 't1', name: 'Laptop name', color: 'red' }], assignments: { w1: ['t1'] } })
  mini.projected(mini.project())
  mini.observeLocal({ tags: [{ id: 't1', name: 'Mini name', color: 'red' }], assignments: {} })
  mini.merge('laptop', laptop.registers()); laptop.merge('mini', mini.registers())
  assert.deepEqual(laptop.tags(), mini.tags())
  const [conflict] = mini.view(true).conflicts
  assert.equal(conflict.kept, 'Mini name'); assert.equal(conflict.other, 'Laptop name')
  assert.equal(laptop.view(true).conflicts.length, 1)
  // Picking the other value settles both machines.
  laptop.resolve(conflict.key, true)
  mini.merge('laptop', laptop.registers())
  assert.equal(mini.tags()[0].name, 'Laptop name')
  assert.equal(mini.view(true).conflicts.length, 0)
})

test('conflicting workspace links are settled by the later write and not shown', () => {
  const laptop = new Groups(emptyGroups(), 'laptop'), mini = new Groups(emptyGroups(), 'mini')
  laptop.set(linkKey('laptop:w1', 'mini:w2'), true)
  mini.set(linkKey('laptop:w1', 'mini:w2'), false)
  mini.merge('laptop', laptop.registers()); laptop.merge('mini', mini.registers())
  assert.deepEqual(laptop.links(), mini.links())
  assert.equal(mini.view(true).conflicts.length, 0)
  assert.equal(laptop.view(true).conflicts.length, 0)
})

test('tags created separately with the same name are both kept under distinct names', () => {
  const laptop = new Groups(emptyGroups(), 'laptop'), mini = new Groups(emptyGroups(), 'mini')
  laptop.observeLocal({ tags: [{ id: 'a', name: 'Work', color: 'blue' }], assignments: {} })
  mini.observeLocal({ tags: [{ id: 'b', name: 'work', color: 'green' }], assignments: {} })
  mini.merge('laptop', laptop.registers())
  assert.deepEqual(mini.project().tags.map(t => t.name).sort(), ['Work', 'work (2)'].sort())
  // Writing the projection back is not mistaken for a rename.
  mini.projected(mini.project())
  assert.equal(mini.observeLocal(mini.project()), false)
})

test('a mirror stores each event once, even after a repeated or interrupted write', async t => {
  const dir = await tempDir(t)
  const mirror = new Mirror('dev', join(dir, 'm'))
  await mirror.load()
  await mirror.update({ cursor: 'c1', sessions: [{ sessionId: 's', updatedAt: 1, lastSeq: 3, archived: false, state: 'idle', pending: [] }] })
  const events = [0, 1, 2].map(seq => ({ type: 'user/message', seq, time: seq, data: { n: seq } }))
  assert.equal((await mirror.append('s', events, 2)).length, 3)
  assert.equal((await mirror.append('s', events, 2)).length, 0)
  // A crash between the log write and the index write leaves a repeated line and a cut-short one.
  await appendFile(join(dir, 'm', 'sessions', 's.jsonl'), `${JSON.stringify(events[2])}\n{"type":"user/mes`)
  const read = await mirror.read('s')
  assert.deepEqual(read.map(e => e.seq), [0, 1, 2])
  assert.deepEqual(mirror.behind().map(s => s.sessionId), ['s'])
  await mirror.append('s', [], 3)
  assert.deepEqual(mirror.behind(), [])
  const reopened = new Mirror('dev', join(dir, 'm')); await reopened.load()
  assert.equal(reopened.session('s')?.storedSeq, 3)
  const blobs = new Blobs(join(dir, 'b'))
  const one = await blobs.put(new Uint8Array([1, 2, 3])), two = await blobs.put(new Uint8Array([1, 2, 3]))
  assert.equal(one, two)
  assert.equal(await blobs.count(), 1)
})

test('only what a person reads is shared, and pending confirmations are found in the log', () => {
  assert.equal(shareEvent({ type: 'request/header', seq: 1, time: 0, data: {} }), undefined)
  assert.equal(shareEvent({ type: 'system/message', seq: 1, time: 0, data: {} }), undefined)
  assert.deepEqual(shareEvent({ type: 'assistant/message', seq: 2, time: 0, data: { message: 1, stream: [1] } })?.data, { message: 1 })
  const asked = { type: 'approval/asked', time: 5, data: { id: 'a1', toolName: 'bash' } }
  assert.equal(openApprovals([asked]).length, 1)
  assert.equal(openApprovals([asked, { type: 'approval/decided', time: 6, data: { id: 'a1', outcome: 'rejected' } }]).length, 0)
  assert.equal(openApprovals([asked, { type: 'turn/end', time: 6, data: {} }]).length, 0)
  const questions = openQuestions([{ callId: 'c1', state: 'open', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }] }] }, { callId: 'c2', state: 'continued', questions: [{ id: 'q', question: 'x' }] }])
  assert.deepEqual(questions.map(q => q.id), ['c1'])
})

test('an approval answered from the other machine withdraws the question from local browsers', async () => {
  const ctx = new Context()
  // A browser answerer that waits until the question is withdrawn.
  let browserSignal: AbortSignal | undefined
  ctx.on('approval/request' as never, ((request: { signal?: AbortSignal }) => new Promise<string>(resolve => {
    browserSignal = request.signal
    request.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  })) as never)
  let answer!: (outcome: 'allowed-once' | 'rejected') => void
  const asks: unknown[] = []
  bridgeApprovalEvent(ctx, ask => { asks.push(ask); return { answer: new Promise(resolve => { answer = resolve }), wait: true } })
  const waterfall = ctx.waterfall as unknown as (...args: unknown[]) => Promise<string>
  const outcome = waterfall.call(ctx, {}, 'approval/request', { agent: { id: 'session-1' }, toolName: 'bash', callId: 'call-1' }, () => Promise.resolve('unavailable'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(asks, [{ sessionId: 'session-1', toolName: 'bash', callId: 'call-1', reason: undefined }])
  assert.ok(browserSignal && !browserSignal.aborted, 'the browser still gets the question')
  answer('allowed-once')
  assert.equal(await outcome, 'allowed-once')
  assert.ok(browserSignal.aborted, 'the browser question is withdrawn')
})

test('an approval answered locally needs nothing from the other machine, and no peer means no change', async () => {
  const ctx = new Context()
  ctx.on('approval/request' as never, (() => Promise.resolve('rejected')) as never)
  let remoteSignal: AbortSignal | undefined
  const stop = bridgeApprovalEvent(ctx, (_ask, signal) => { remoteSignal = signal; return { answer: new Promise(() => {}), wait: true } })
  const waterfall = ctx.waterfall as unknown as (...args: unknown[]) => Promise<string>
  assert.equal(await waterfall.call(ctx, {}, 'approval/request', { agent: { id: 's' }, toolName: 'bash' }, () => Promise.resolve('unavailable')), 'rejected')
  assert.ok(remoteSignal?.aborted, 'the other machine\'s copy of the question is withdrawn')
  stop()
  const plain = new Context()
  bridgeApprovalEvent(plain, () => undefined)
  const plainWaterfall = plain.waterfall as unknown as (...args: unknown[]) => Promise<string>
  assert.equal(await plainWaterfall.call(plain, {}, 'approval/request', { agent: { id: 's' }, toolName: 'bash' }, () => Promise.resolve('unavailable')), 'unavailable')
})
