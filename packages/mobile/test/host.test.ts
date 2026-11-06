import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { dshHost } from '../src/server/bridge/host.js'

const host = (services: Record<string, unknown>) => dshHost({ get: (name: string) => services[name] } as unknown as Context)
const signal = new AbortController().signal
const event = (seq: number) => ({ type: 'turn/start', seq, time: seq, data: {} })

test('on DSH 0.2.1 a session is read through the session controller', async () => {
  const read = host({ sessionController: { inspect: async (id: string) => ({ meta: { id, createdAt: 0 }, events: [event(0)] }) } })
  assert.deepEqual((await read.inspect('s1', signal)).events, [event(0)])
})

test('on DSH 0.2.2, which removed inspect, the whole log comes from one session query that is then released', async () => {
  const asked: unknown[] = []
  let released = 0
  const read = host({
    sessionController: {},
    sessionQuery: {
      observeSession: async (id: string, options: { signal?: AbortSignal; projectionMode?: string }) => {
        asked.push([id, options.signal === signal, options.projectionMode])
        return { header: { id, cwd: '/work' }, events: [event(0), event(1)], [Symbol.dispose]() { released++ } }
      },
    },
  })
  assert.deepEqual((await read.inspect('s1', signal)).events, [event(0), event(1)])
  assert.deepEqual(asked, [['s1', true, 'none']], 'no projections are computed for a plain read')
  assert.equal(released, 1)
})

test('a session query that cannot be read reports the failure, and a host with no way to read says so', async () => {
  const read = host({ sessionController: {}, sessionQuery: { observeSession: async () => { throw new Error('not found') } } })
  await assert.rejects(read.inspect('s1', signal), /not found/)
  await assert.rejects(host({ sessionController: {} }).inspect('s1', signal), /cannot read sessions/)
})

async function collect(frames: unknown[]) {
  const seen: { sessionId: string; active: unknown }[] = []
  const stream = host({ sessionController: { control: async function* () { yield* frames } } }).questions(signal)
  for await (const update of stream) seen.push(update)
  return seen
}

test('open questions follow the one-key projection frames of DSH 0.2.1', async () => {
  assert.deepEqual(await collect([
    { type: 'baseline', value: { projections: { s1: { values: { userQuestions: { active: 'first' } } } } } },
    { type: 'projection', sessionId: 's1', key: 'title', value: 'ignored' },
    { type: 'projection', sessionId: 's1', key: 'userQuestions', value: { active: 'second' } },
  ]), [{ sessionId: 's1', active: 'first' }, { sessionId: 's1', active: 'second' }])
})

test('open questions follow the frames of DSH 0.2.2, which list every key one event changed', async () => {
  assert.deepEqual(await collect([
    { type: 'projection', sessionId: 's1', seq: 4, changes: [{ key: 'title', val: 'ignored' }, { key: 'userQuestions', val: { active: 'asked' } }] },
    { type: 'projection', sessionId: 's2', seq: 5, changes: [{ key: 'title', val: 'ignored' }] },
    { type: 'projection', sessionId: 's1', seq: 6, changes: [{ key: 'userQuestions', val: {} }] },
  ]), [{ sessionId: 's1', active: 'asked' }, { sessionId: 's1', active: undefined }])
})
