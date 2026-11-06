import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { openQuestions } from '../src/server/bridge/events.js'
import { bridgeQuestionEvent, dshHost } from '../src/server/bridge/host.js'

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

test('a late answer goes to the session’s live agent, and a session with none has nothing to answer', async () => {
  const agent = { id: 's1' }
  const calls: unknown[] = []
  const services = {
    agents: { get: (id: string) => id === 's1' ? agent : undefined },
    userQuestions: { answer: (who: unknown, callId: string, answer: unknown) => { calls.push([who, callId, answer]); return true } },
  }
  const answers = [{ id: 'q1', selected: ['Alpha'] }]
  assert.equal(await host(services).answerQuestion('s1', 'c1', answers), true)
  assert.deepEqual(calls, [[agent, 'c1', { answers }]])
  assert.equal(await host(services).answerQuestion('closed', 'c1', answers), false)
  assert.equal(calls.length, 1)
})

test('DSH’s question list keeps questions still waiting and ones past their foreground wait', () => {
  const question = { id: 'q1', question: 'Which?' }
  const open = openQuestions([
    { callId: 'a', questions: [question], state: 'open' },
    { callId: 'b', questions: [question], state: 'continued' },
    { callId: 'c', questions: [question], state: 'settled' },
    { callId: 'd', questions: [question] },
  ], 5)
  assert.deepEqual(open.map(item => item.id), ['a', 'b', 'd'])
})

/** DSH's waterfall as far as the bridge uses it: this plugin's listener first, then the browsers, then `next`. */
function waterfallHost(browsers: (request: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>) {
  let listener: ((this: unknown, request: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const scope = {}
  const ctx = {
    on: (_event: string, handler: typeof listener) => { listener = handler; return () => {} },
    waterfall: function (this: unknown, target: unknown, event: string, request: Record<string, unknown>, next: () => Promise<unknown>) {
      assert.equal(target, scope); assert.equal(event, 'user-questions/request')
      return listener!.call(scope, request, () => browsers(request, next))
    },
  } as unknown as Context
  const noAnswerer = () => Promise.reject(Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' }))
  return { ctx, ask: (request: Record<string, unknown>) => (ctx as unknown as { waterfall: Function }).waterfall(scope, 'user-questions/request', request, noAnswerer) as Promise<unknown> }
}
const asking = { agent: { id: 's1' }, questions: [{ id: 'q1', question: 'Which?' }], wait: { callId: 'c1' } }
const pending = () => { let settle!: (value: unknown) => void, fail!: (reason: unknown) => void; const promise = new Promise((ok, no) => { settle = ok; fail = no }); return { promise, settle, fail } }

test('the phone’s answer settles a question while the browsers still wait, and takes it back from them', async () => {
  const browser = pending(); let browserSignal: AbortSignal | undefined
  const { ctx, ask } = waterfallHost(async (request) => { browserSignal = request.signal as AbortSignal; return browser.promise })
  const answers = [{ id: 'q1', selected: ['Alpha'] }]
  const asks: unknown[] = []
  bridgeQuestionEvent(ctx, (question) => { asks.push(question); return { answer: Promise.resolve(answers), wait: true } })
  assert.deepEqual(await ask({ ...asking }), { answers })
  assert.deepEqual(asks, [{ sessionId: 's1', callId: 'c1', questions: asking.questions }])
  assert.equal(browserSignal?.aborted, true)
})

test('a browser’s answer settles a question and takes it back from the phone', async () => {
  let phoneSignal: AbortSignal | undefined
  const { ctx, ask } = waterfallHost(async () => ({ answers: [{ id: 'q1', selected: ['Beta'] }] }))
  bridgeQuestionEvent(ctx, (_question, signal) => { phoneSignal = signal; return { answer: new Promise(() => {}), wait: true } })
  assert.deepEqual(await ask({ ...asking }), { answers: [{ id: 'q1', selected: ['Beta'] }] })
  assert.equal(phoneSignal?.aborted, true)
})

test('with no browser open a question waits for the phone, and fails as before when no phone will answer', async () => {
  const answers = [{ id: 'q1', selected: ['Alpha'] }], phone = pending()
  const none = async (_request: Record<string, unknown>, next: () => Promise<unknown>) => next()
  const waiting = waterfallHost(none)
  bridgeQuestionEvent(waiting.ctx, () => ({ answer: phone.promise as Promise<typeof answers>, wait: true }))
  const result = waiting.ask({ ...asking })
  await new Promise(resolve => setTimeout(resolve, 5))
  phone.settle(answers)
  assert.deepEqual(await result, { answers })
  const absent = waterfallHost(none)
  bridgeQuestionEvent(absent.ctx, () => undefined)
  await assert.rejects(absent.ask({ ...asking }), /no answerer/)
  const quiet = waterfallHost(none)
  bridgeQuestionEvent(quiet.ctx, () => ({ answer: new Promise(() => {}), wait: false }))
  await assert.rejects(quiet.ask({ ...asking }), /no answerer/)
})

test('a question the turn gives up on ends for the phone too, with the reason DSH gave', async () => {
  const controller = new AbortController(); let phoneSignal: AbortSignal | undefined
  const browser = pending()
  const { ctx, ask } = waterfallHost(async () => browser.promise)
  bridgeQuestionEvent(ctx, (_question, signal) => { phoneSignal = signal; return { answer: new Promise(() => {}), wait: true } })
  const result = ask({ ...asking, signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 5))
  browser.fail(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }))
  await assert.rejects(result, /timed out/)
  assert.equal(phoneSignal?.aborted, true)
  const none = waterfallHost(async (_request, next) => next())
  const stop = new AbortController()
  bridgeQuestionEvent(none.ctx, () => ({ answer: new Promise(() => {}), wait: true }))
  const waiting = none.ask({ ...asking, signal: stop.signal })
  await new Promise(resolve => setTimeout(resolve, 5))
  stop.abort(new Error('turn stopped'))
  await assert.rejects(waiting)
})

test('stopping a turn while a browser or the phone holds its question leaves no unhandled rejection, which would take DSH down', async () => {
  const unhandled: unknown[] = []
  const note = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', note)
  try {
    for (const browsers of [
      (request: Record<string, unknown>) => new Promise((_ok, no) => { (request.signal as AbortSignal).addEventListener('abort', () => no(Object.assign(new Error('stopped'), { code: 'ASK_ABORTED' })), { once: true }) }),
      async (_request: Record<string, unknown>, next: () => Promise<unknown>) => next(),
    ]) {
      const stop = new AbortController()
      const { ctx, ask } = waterfallHost(browsers)
      bridgeQuestionEvent(ctx, () => ({ answer: new Promise(() => {}), wait: true }))
      const result = ask({ ...asking, signal: stop.signal })
      await new Promise(resolve => setTimeout(resolve, 5))
      stop.abort({ kind: 'user' })
      await assert.rejects(result)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', note) }
})

test('DSH’s default questions name no tool call, so each gets its own ID for the phone', async () => {
  const seen: string[] = []
  const { ctx, ask } = waterfallHost(async () => ({ answers: [] }))
  bridgeQuestionEvent(ctx, (question) => { seen.push(question.callId); return { answer: new Promise(() => {}), wait: true } })
  await ask({ agent: { id: 's1' }, questions: asking.questions })
  await ask({ agent: { id: 's1' }, questions: asking.questions })
  assert.equal(new Set(seen).size, 2)
  assert.ok(seen.every(id => id.length > 0))
})

test('a request from no session passes through untouched', async () => {
  const { ctx, ask } = waterfallHost(async () => 'browser')
  let asked = 0
  bridgeQuestionEvent(ctx, () => { asked++; return undefined })
  assert.equal(await ask({ questions: asking.questions, wait: { callId: 'c1' } }), 'browser')
  assert.equal(asked, 0)
})
