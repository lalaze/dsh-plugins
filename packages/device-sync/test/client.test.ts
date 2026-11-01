import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { canCommand, canInteract, isDefiniteRejection, mergeEvents, visibleSessions } from '../src/client/view-model.js'
import type { MirrorSessionView, PeerStatus, SyncedEvent } from '../src/shared/protocol.js'

const peer = (connection: PeerStatus['connection'], command = true) => ({ connection, grantsFromPeer: { command, history: true } } as PeerStatus)
const session = (extra: Partial<MirrorSessionView> = {}) => ({ deviceId: 'a', sessionId: 's', updatedAt: 0, lastSeq: 0, storedSeq: 0, archived: false, state: 'idle', pending: [], ...extra } as MirrorSessionView)
test('commands require an active pairing and remote command grant, not local grants', () => {
  assert.equal(canCommand(undefined), false)
  for (const connection of ['online', 'offline', 'paused', 'unpaired'] as const) assert.equal(canCommand(peer(connection, false)), false)
  assert.equal(canCommand(peer('paused')), false)
  assert.equal(canCommand(peer('unpaired')), false)
  assert.equal(canCommand(peer('online')), true)
  assert.equal(canCommand(peer('offline')), true) // prompt may be explicitly held, not executed
  assert.equal(canInteract(peer('offline')), false) // stale approvals/answers/cancel are not offered offline
  assert.equal(canInteract(peer('online')), true)
})
test('hidden and subagent sessions are opt-in; archive/deletion remain visible history', () => {
  const sessions = [session(), session({ hidden: true }), session({ origin: 'subagent' }), session({ archived: true }), session({ removed: true })]
  assert.equal(visibleSessions(sessions, false, false).length, 3)
  assert.equal(visibleSessions(sessions, true, false).length, 4)
  assert.equal(visibleSessions(sessions, false, true).length, 4)
  assert.equal(visibleSessions(sessions, true, true).length, 5)
})
test('overlapping history fetches deduplicate and preserve sequence gaps', () => {
  const event = (seq: number, data = ''): SyncedEvent => ({ seq, data, time: 0, type: 'user/message' })
  const old = [event(1), event(5)]
  const merged = mergeEvents(old, [event(5, 'updated'), event(9), event(2)])
  assert.deepEqual(merged.map(e => e.seq), [1, 2, 5, 9])
  assert.equal(merged[2].data, 'updated')
  assert.equal(old.length, 2)
})

test('definite HTTP rejections unlock editing, ambiguous outcomes keep the original request ID', () => {
  for (const status of [400, 401, 403, 404, 409, 413, 422, 429]) assert.equal(isDefiniteRejection(status), true)
  for (const status of [undefined, 408, 500, 502, 503, 504]) assert.equal(isDefiniteRejection(status), false)
})
