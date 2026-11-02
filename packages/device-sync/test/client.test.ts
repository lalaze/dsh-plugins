import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { canCommand, canInteract, continuation, groupReach, isDefiniteRejection, matchSessions, mergeEvents, visibleSessions } from '../src/client/view-model.js'
import { matchingWorkspace, normalizeRemotePath, remoteLabel, sameRemote, type LocalStatus, type MirrorSessionView, type PeerStatus, type RemoteBinding, type SyncedEvent, type WorkspaceEntry } from '../src/shared/protocol.js'

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
test('group changes are blocked where they can never arrive, and only delayed while paused or offline', () => {
  const at = (connection: PeerStatus['connection'], history = true) => ({ connection, grantsToPeer: { history, command: false } } as PeerStatus)
  assert.equal(groupReach(undefined), 'blocked-unpaired')
  assert.equal(groupReach(at('unpaired')), 'blocked-unpaired')
  for (const connection of ['online', 'offline', 'paused'] as const) assert.equal(groupReach(at(connection, false)), 'blocked-sharing')
  assert.equal(groupReach(at('paused')), 'paused')
  assert.equal(groupReach(at('offline')), 'offline')
  assert.equal(groupReach(at('online')), 'ok')
})
test('hidden and subagent sessions are opt-in; archive/deletion remain visible history', () => {
  const sessions = [session(), session({ hidden: true }), session({ origin: 'subagent' }), session({ archived: true }), session({ removed: true })]
  assert.equal(visibleSessions(sessions, false, false).length, 3)
  assert.equal(visibleSessions(sessions, true, false).length, 4)
  assert.equal(visibleSessions(sessions, false, true).length, 4)
  assert.equal(visibleSessions(sessions, true, true).length, 5)
})
test('session search matches title, id, workspace and folder, ignoring case', () => {
  const sessions = [session({ sessionId: 'a1', title: '部署连通性测试' }), session({ sessionId: 'session-2249', workspaceId: 'w' }), session({ sessionId: 'c3', title: 'Push to Tailscale', cwd: '/srv/zebox' })]
  const workspace = (s: MirrorSessionView) => s.workspaceId === 'w' ? 'dsh-plugins' : undefined
  const ids = (query: string) => matchSessions(sessions, query, workspace).map(s => s.sessionId)
  assert.deepEqual(ids('  '), ['a1', 'session-2249', 'c3'])
  assert.deepEqual(ids('连通'), ['a1'])
  assert.deepEqual(ids('SESSION-22'), ['session-2249'])
  assert.deepEqual(ids('dsh-PLUG'), ['session-2249'])
  assert.deepEqual(ids('tailscale'), ['c3'])
  assert.deepEqual(ids('zebox'), ['c3'])
  assert.deepEqual(ids('missing'), [])
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

test('SSH workspaces are the same project only with the same host, user, port and normalized directory', () => {
  const api: RemoteBinding = { host: 'Dev.Example.com', username: 'me', port: 22, remotePath: '/srv/api' }
  assert.equal(normalizeRemotePath('/srv/./web/../api//'), '/srv/api')
  for (const same of [api, { ...api, host: 'dev.example.com.' }, { ...api, remotePath: '/srv/./web/../api/' }, { ...api, alias: 'other-alias' }]) assert.equal(sameRemote(api, same), true, JSON.stringify(same))
  assert.equal(sameRemote({ ...api, host: '[fd7a::1]' }, { ...api, host: 'FD7A::1' }), true)
  for (const other of [{ ...api, host: 'dev2.example.com' }, { ...api, username: 'Me' }, { ...api, port: 2222 }, { ...api, remotePath: '/srv/api/sub' }, { ...api, remotePath: '/srv' }]) assert.equal(sameRemote(api, other), false, JSON.stringify(other))
  // Bindings from the paired machine may be missing or malformed; those match nothing.
  for (const bad of [undefined, { ...api, port: '22' }, { ...api, username: '' }, { ...api, remotePath: 'srv/api' }, { host: 'x' }] as RemoteBinding[]) {
    assert.equal(sameRemote(api, bad), false); assert.equal(sameRemote(bad, bad), false)
  }
  assert.equal(remoteLabel(api), 'ssh://me@Dev.Example.com/srv/api')
  assert.equal(remoteLabel({ ...api, host: 'fd7a::1', port: 2222 }), 'ssh://me@[fd7a::1]:2222/srv/api')
  const workspace = (workspaceId: string, remote?: RemoteBinding) => ({ workspaceId, title: workspaceId, path: `/p/${workspaceId}`, sessionIds: [], order: 0, ...(remote ? { remote } : {}) } as WorkspaceEntry)
  const local = [workspace('plain'), workspace('web', { ...api, remotePath: '/srv/web' }), workspace('api', { ...api, host: 'dev.example.com' }), workspace('api-2', api)]
  assert.equal(matchingWorkspace(api, local)?.workspaceId, 'api')
  assert.equal(matchingWorkspace({ ...api, port: 2200 }, local), undefined)
  assert.equal(matchingWorkspace(undefined, local), undefined)
})

test('continuing here is offered for SSH workspaces only, with this machine\'s matching workspace when there is one', () => {
  const api: RemoteBinding = { host: 'dev', username: 'me', port: 22, remotePath: '/srv/api' }
  const status = (localRemote?: RemoteBinding) => ({ device: { deviceId: 'here', name: 'Mac mini' }, workspaces: [
    { deviceId: 'here', items: [{ workspaceId: 'mine', title: 'api', path: '/h/api', sessionIds: [], order: 0, ...(localRemote ? { remote: localRemote } : {}) }] },
    { deviceId: 'a', items: [{ workspaceId: 'ssh', title: 'api', path: '/l/api', sessionIds: [], order: 0, remote: api }, { workspaceId: 'plain', title: 'notes', path: '/l/notes', sessionIds: [], order: 1 }] },
  ] } as unknown as LocalStatus)
  assert.equal(continuation(status(api), session({ workspaceId: 'plain' })), undefined)
  assert.equal(continuation(status(api), session()), undefined, 'a session outside any workspace')
  assert.equal(continuation(status(api), session({ workspaceId: 'ssh' }))?.local?.workspaceId, 'mine')
  assert.deepEqual(continuation(status({ ...api, remotePath: '/srv/web' }), session({ workspaceId: 'ssh' })), { remote: api })
  assert.deepEqual(continuation(status(), session({ workspaceId: 'ssh' })), { remote: api })
})
