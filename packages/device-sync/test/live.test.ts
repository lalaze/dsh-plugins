import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readLiveFrames, reconnectLive, retryLiveError } from '../src/client/live.js'
import type { LiveFrame } from '../src/shared/protocol.js'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

test('live decoder handles split UTF-8, blank lines and EOF without newline, releasing reader', async () => {
  const bytes = new TextEncoder().encode('\n{"type":"draft","attemptId":"a","text":"中文","reasoning":""}\n{"type":"ping"}')
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } })
  const frames: LiveFrame[] = []
  await readLiveFrames(body, new AbortController().signal, f => frames.push(f))
  assert.equal(frames.length, 2)
  assert.equal(frames[0].type === 'draft' && frames[0].text, '中文')
  assert.equal(frames[1].type, 'ping')
  assert.equal(body.locked, false)
})

test('abort cancels pending live reads and releases lock without emitting frames', async () => {
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })
  const controller = new AbortController()
  const reading = readLiveFrames(body, controller.signal, () => assert.fail('no frames'))
  controller.abort()
  await reading
  assert.equal(cancelled, 1)
  assert.equal(body.locked, false)
})

test('malformed frames and frame callbacks failing cancel and release the reader', async () => {
  for (const contents of ['not json\n', '{"type":"ping"}\n']) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(contents)) }, cancel() { cancelled = true } })
    await assert.rejects(readLiveFrames(body, new AbortController().signal, () => { throw new Error('frame error') }))
    assert.equal(cancelled, true)
    assert.equal(body.locked, false)
  }
})

test('EOF and network errors reconnect serially after 3 seconds; abort clears delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let connects = 0, inflight = 0, maximum = 0
  const failures: boolean[] = []
  const following = reconnectLive(controller.signal, async () => {
    connects++; inflight++; maximum = Math.max(maximum, inflight)
    await Promise.resolve(); inflight--
    if (connects === 2) throw new Error('network')
  }, (_, retrying) => failures.push(retrying))
  await flush()
  assert.equal(connects, 1)
  t.mock.timers.tick(2999); await flush(); assert.equal(connects, 1)
  t.mock.timers.tick(1); await flush(); assert.equal(connects, 2)
  t.mock.timers.tick(3000); await flush(); assert.equal(connects, 3)
  controller.abort(); await following
  t.mock.timers.tick(3000); await flush()
  assert.equal(connects, 3)
  assert.equal(maximum, 1)
  assert.deepEqual(failures, [true, true, true])
})

test('permanent HTTP denial stops retrying; abort during connection suppresses failure callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const status of [401, 403, 404]) {
    let connects = 0
    await reconnectLive(new AbortController().signal, async () => { connects++; throw { status } }, (_, retrying) => assert.equal(retrying, false))
    t.mock.timers.tick(9000); await flush()
    assert.equal(connects, 1)
  }
  const controller = new AbortController()
  const following = reconnectLive(controller.signal, () => new Promise(resolve => controller.signal.addEventListener('abort', () => resolve())), () => assert.fail('abort is not a connection failure'))
  controller.abort(); await following
  for (const status of [408, 429, 500, 503]) assert.equal(retryLiveError({ status }), true)
})
