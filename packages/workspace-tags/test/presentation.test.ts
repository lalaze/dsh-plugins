import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupNode, SessionNode } from '../src/client/upstream/tree.ts'
import { canonicalKey, collectPresentation, flattenPresentation, groupRecency, presentationActivity, projectPresentation, sectionPresentation, type MirrorContribution } from '../src/client/upstream/presentation.ts'
import { UNTAGGED_FILTER } from '../src/client/tags/sections.ts'
const tags = { tags: [{ id: 'work', name: 'Work', color: 'blue' as const }], assignments: { same: ['work'] } }
const node = (title: string, time: number): SessionNode => ({ id: 'same' as SessionId, title, blank: false, pinned: false, archived: false, running: false, completed: false, runningSubagentCount: 0, updatedAt: time })
const group = (device: string): GroupNode => ({ key: 'same', workspaceId: 'same' as WorkspaceId, label: 'Same name', cwd: '/same/path', createdAt: 0, sessionCount: 1, containsCurrent: false, expanded: true, sessions: [node(`${device} body`, device === 'a' ? 1 : 2)] })
function peer(local: string, remote: string): MirrorContribution {
  return { localDevice: { deviceId: local, name: local }, workspaces: [{ deviceId: remote, workspaceId: 'same', title: 'Same name', displayPath: '/same/path', order: 0, sessionIds: ['same'], tagIds: ['work'], ownerName: remote, connection: 'online' }], sessions: [{ deviceId: remote, sessionId: 'same', workspaceId: 'same', title: `${remote} body`, updatedAt: remote === 'a' ? 1 : 2, archived: false, hidden: false, subagent: false, running: false, waiting: false, ownerName: remote, connection: 'online' }], visibility: { showHidden: false, showSubagents: false }, openSession: () => { throw new Error('projection must not execute') }, renderTagEditor: () => null }
}
test('swapping native and mirror owners yields the same canonical collection and manual/updated order; names, paths and ids never merge', () => {
  for (const order of ['manual', 'updated'] as const) {
    const a = projectPresentation(collectPresentation([group('a')], tags, peer('a', 'b')), tags, { tagId: null, archived: 'default', order })
    const b = projectPresentation(collectPresentation([group('b')], tags, peer('b', 'a')), tags, { tagId: null, archived: 'default', order })
    assert.equal(a.length, 2)
    assert.deepEqual(a.map(g => g.canonicalKey), b.map(g => g.canonicalKey))
    assert.deepEqual(flattenPresentation(a, order).map(s => s.canonicalKey), flattenPresentation(b, order).map(s => s.canonicalKey))
    assert.equal(a[0].deviceId, order === 'manual' ? 'a' : 'b')
  }
})
test('local render identity and native payload references stay stable while provider loads, disappears and reconnects', () => {
  const local = group('a')
  for (const source of [undefined, peer('a', 'b'), undefined, peer('a', 'b')]) {
    const row = collectPresentation([local], tags, source).find(g => g.owner === 'local')!
    assert.equal(row.key, 'local:same')
    assert.equal(row.owner, 'local')
    if (row.owner === 'local') assert.equal(row.native, local)
    assert.equal(row.sessions[0].key, 'local:same')
  }
})
test('both loose buckets retain owning device identities, including colliding session ids and absent workspace metadata', () => {
  const local: GroupNode = { ...group('a'), key: '', workspaceId: undefined, cwd: undefined }
  const contribution = peer('a', 'b'); contribution.workspaces = []; contribution.sessions = contribution.sessions.map(({ workspaceId: _, ...session }) => session)
  const result = collectPresentation([local], tags, contribution)
  assert.deepEqual(result.map(g => g.canonicalKey), [canonicalKey('a', 'workspace'), canonicalKey('b', 'workspace')])
  assert.equal(new Set(result.flatMap(g => g.sessions.map(s => s.canonicalKey))).size, 2)
})
test('one tag/query/archive/group/count pipeline covers both owners; mirrored hidden/child flags remain display-only', () => {
  const contribution = peer('a', 'b')
  contribution.sessions = [{ ...contribution.sessions[0]!, waiting: true }, { ...contribution.sessions[0]!, sessionId: 'child', subagent: true }, { ...contribution.sessions[0]!, sessionId: 'hidden', hidden: true }]
  const all = collectPresentation([group('a')], tags, contribution)
  const visible = projectPresentation(all, tags, { tagId: 'work', archived: 'default', query: 'body', order: 'updated' })
  assert.equal(visible.flatMap(g => g.sessions).length, 2)
  assert.equal(sectionPresentation(visible, tags, 'tag')[0]?.groups.length, 2)
  assert.equal(sectionPresentation(visible, tags, 'status').find(s => s.kind === 'waiting')?.groups[0]?.deviceId, 'b')
  assert.equal(presentationActivity(visible, tags).get('work')?.waiting, 1)
  assert.equal(projectPresentation(all, tags, { tagId: 'missing', archived: 'default', order: 'updated' }).length, 0)
  contribution.workspaces = contribution.workspaces.map(w => ({ ...w, tagIds: ['deleted'] }))
  assert.equal(projectPresentation(collectPresentation([group('a')], tags, contribution), tags, { tagId: UNTAGGED_FILTER, archived: 'default', order: 'updated' })[0]?.deviceId, 'b')
  contribution.visibility = { showHidden: true, showSubagents: true }
  assert.equal(collectPresentation([group('a')], tags, contribution).flatMap(g => g.sessions).length, 4)
})
test('a native full-text match only augments its qualified local session, never the same-id mirror', () => {
  const all = collectPresentation([group('a')], tags, peer('a', 'b'))
  const result = projectPresentation(all, tags, { tagId: null, archived: 'default', query: 'body only needle', order: 'updated' }, new Set(['local:same']))
  assert.equal(result.length, 1)
  assert.equal(result[0]?.owner, 'local')
})

test('workspace recency survives role swaps and blank/hidden/archive filtering while removed and non-member history cannot raise it', () => {
  for (const kind of ['blank', 'hidden', 'archived', 'removed'] as const) {
    const rawTime = (owner: string) => owner === 'a' ? kind === 'removed' ? 0 : 500 : 100
    const make = (local: string, remote: string) => {
      const native = group(local)
      native.sessions = local === 'a' && ['blank', 'hidden', 'removed'].includes(kind) ? [] : [{ ...node(`${local} history`, rawTime(local)), archived: local === 'a' && kind === 'archived' }]
      const contribution = peer(local, remote)
      contribution.sessions = [{ ...contribution.sessions[0]!, title: remote === 'a' && kind === 'blank' ? '' : `${remote} history`, updatedAt: remote === 'a' ? 500 : 100, archived: remote === 'a' && kind === 'archived', hidden: remote === 'a' && kind === 'hidden', removed: remote === 'a' && kind === 'removed' }]
      contribution.sessions = [...contribution.sessions,
        { ...contribution.sessions[0]!, deviceId: local, updatedAt: 999_999, removed: false }, // identical ID, wrong owner
        { ...contribution.sessions[0]!, sessionId: 'foreign', workspaceId: 'another-workspace', updatedAt: 999_999, removed: false }, // not a current member
        { ...contribution.sessions[0]!, sessionId: 'old-deleted', updatedAt: 999_999, removed: true },
      ]
      contribution.workspaces = contribution.workspaces.map(workspace => ({ ...workspace, sessionIds: ['same', 'old-deleted'] }))
      return collectPresentation([native], tags, contribution, new Map([['same', rawTime(local)]]))
        .filter(g => JSON.parse(g.canonicalKey)[2] === 'same')
    }
    const a = make('a', 'b'), b = make('b', 'a')
    for (const owner of ['a', 'b']) {
      assert.equal(groupRecency(a.find(g => g.deviceId === owner)!), rawTime(owner), kind)
      assert.equal(groupRecency(b.find(g => g.deviceId === owner)!), rawTime(owner), kind)
    }
    for (const archived of ['default', 'show'] as const) {
      const filter = { tagId: 'work', archived, order: 'updated' as const }
      const aa = projectPresentation(a, tags, filter), bb = projectPresentation(b, tags, filter)
      assert.deepEqual(aa.map(g => g.canonicalKey), bb.map(g => g.canonicalKey), kind)
      assert.equal(aa[0]?.deviceId, kind === 'removed' ? 'b' : 'a')
    }
    if (kind === 'blank') assert.equal(a.find(g => g.owner === 'local')?.sessions.length, 0, 'sorting never inserts a reusable native blank row')
  }
})
