import assert from 'node:assert/strict'
import { test } from 'node:test'
import { statusOf } from '../app/src/parts.js'
import type { SessionEntry } from '../src/shared/protocol.js'

const entry = (fields: Partial<SessionEntry> = {}): SessionEntry => ({ sessionId: 's', updatedAt: 0, lastSeq: 10, archived: false, state: 'idle', pending: [], ...fields })

test('a finished session reads as done until it is seen on the phone or read elsewhere', () => {
  assert.equal(statusOf(entry(), 5), 'done')
  assert.equal(statusOf(entry(), 10), 'idle', 'seen on the phone')
  assert.equal(statusOf(entry({ readSeq: 10 }), 5), 'idle', 'read on another computer')
  assert.equal(statusOf(entry({ readSeq: 8 }), 5), 'done', 'output came after that read')
  assert.equal(statusOf(entry({ readSeq: 8 }), 10), 'idle')
})

test('work under way shows however far it has been read', () => {
  assert.equal(statusOf(entry({ state: 'running', readSeq: 10 }), 10), 'running')
  assert.equal(statusOf(entry({ state: 'waiting', readSeq: 10 }), 10), 'waiting')
})
