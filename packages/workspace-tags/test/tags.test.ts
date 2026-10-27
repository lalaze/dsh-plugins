import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { handleTagRequest } from '../src/index.ts'
import { TagStore } from '../src/server/store.ts'
import { applyTagOperation, emptyTagState, parseTagState, TagError, type TagOperation, type TagState } from '../src/shared/tags.ts'

const ids = () => { let n = 0; return () => `t${++n}` }
const run = (state: TagState, ...operations: TagOperation[]) => {
  const next = ids()
  return operations.reduce((current, operation) => applyTagOperation(current, operation, next).state, state)
}

test('a created tag can be assigned at once, and toggling keeps assignment order', () => {
  const state = run(emptyTagState(),
    { op: 'create', name: '  Client   work ', color: 'blue', assignTo: 'ws-a' },
    { op: 'create', name: 'Urgent', color: 'red' },
    { op: 'assign', workspaceId: 'ws-a', tagId: 't2', assigned: true },
    { op: 'assign', workspaceId: 'ws-b', tagId: 't2', assigned: true })
  assert.deepEqual(state.tags, [{ id: 't1', name: 'Client work', color: 'blue' }, { id: 't2', name: 'Urgent', color: 'red' }])
  assert.deepEqual(state.assignments, { 'ws-a': ['t1', 't2'], 'ws-b': ['t2'] })
  const removed = run(state, { op: 'assign', workspaceId: 'ws-b', tagId: 't2', assigned: false })
  assert.deepEqual(removed.assignments, { 'ws-a': ['t1', 't2'] }, 'a Workspace without tags leaves no empty entry')
  assert.deepEqual(run(state, { op: 'assign', workspaceId: 'ws-a', tagId: 't1', assigned: true }).assignments['ws-a'], ['t2', 't1'],
    're-assigning moves the tag last instead of duplicating it')
})

test('names are trimmed, bounded and unique ignoring case', () => {
  const state = run(emptyTagState(), { op: 'create', name: 'Backend', color: 'green' })
  const reject = (operation: TagOperation, message: RegExp) =>
    assert.throws(() => applyTagOperation(state, operation, ids()), (error: unknown) => error instanceof TagError && message.test(error.message))
  reject({ op: 'create', name: 'backend', color: 'red' }, /already exists/)
  reject({ op: 'create', name: '   ', color: 'red' }, /Enter a tag name/)
  reject({ op: 'create', name: 'x'.repeat(41), color: 'red' }, /at most 40/)
  reject({ op: 'create', name: 'Ok', color: 'chartreuse' as never }, /color/)
  reject({ op: 'update', id: 'missing', name: 'x' }, /no longer exists/)
  reject({ op: 'assign', workspaceId: '', tagId: 't1', assigned: true }, /Unknown workspace/)
  reject({ op: 'nope' } as never, /Unknown tag operation/)
  assert.equal(run(state, { op: 'update', id: 't1', name: 'BACKEND' }).tags[0]!.name, 'BACKEND', 'a tag may change its own case')
  assert.equal(applyTagOperation(state, { op: 'create', name: '标签'.repeat(20), color: 'pink' }, ids()).tag?.name.length, 40, 'length counts characters')
})

test('deleting a tag removes it from every Workspace, and forget drops a Workspace', () => {
  const state = run(emptyTagState(),
    { op: 'create', name: 'A', color: 'gray', assignTo: 'ws-a' },
    { op: 'create', name: 'B', color: 'teal', assignTo: 'ws-a' },
    { op: 'assign', workspaceId: 'ws-b', tagId: 't1', assigned: true })
  assert.deepEqual(run(state, { op: 'delete', id: 't1' }), { tags: [{ id: 't2', name: 'B', color: 'teal' }], assignments: { 'ws-a': ['t2'] } })
  assert.deepEqual(run(state, { op: 'forget', workspaceId: 'ws-a' }).assignments, { 'ws-b': ['t1'] })
  const before = structuredClone(state)
  run(state, { op: 'delete', id: 't2' })
  assert.deepEqual(state, before, 'operations never mutate their input')
})

test('stored state is read leniently', () => {
  assert.deepEqual(parseTagState({
    tags: [
      { id: 'a', name: 'One', color: 'red' }, { id: 'a', name: 'Dup id', color: 'red' }, { id: 'b', name: 'one', color: 'blue' },
      { id: 'c', name: 'Two', color: 'neon' }, { id: 'd', name: 'Three', color: 'green' }, null,
    ],
    assignments: { ws: ['a', 'a', 'b', 'zzz', 3], empty: ['zzz'], bad: 'a', '': ['a'] },
  }), { tags: [{ id: 'a', name: 'One', color: 'red' }, { id: 'd', name: 'Three', color: 'green' }], assignments: { ws: ['a'] } })
  assert.deepEqual(parseTagState('garbage'), emptyTagState())
})

test('the store persists atomically and keeps its state when a write fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-tags-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'tags.json')
  const store = new TagStore(path)
  await store.load()
  const [first, second] = await Promise.all([
    store.apply({ op: 'create', name: 'One', color: 'red', assignTo: 'ws' }),
    store.apply({ op: 'create', name: 'Two', color: 'blue' }),
  ])
  assert.equal(first.tag?.name, 'One'); assert.equal(second.state.tags.length, 2, 'writes are serialized')
  await assert.rejects(store.apply({ op: 'create', name: 'one', color: 'red' }), TagError)
  assert.equal(store.snapshot().tags.length, 2)
  const reopened = new TagStore(path); await reopened.load()
  assert.deepEqual(reopened.snapshot(), store.snapshot())
  assert.deepEqual((await readdir(join(dir, 'nested'))).filter(name => name.endsWith('.tmp')), [])
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1)
})

test('an unreadable file is set aside instead of blocking the sidebar', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-tags-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tags.json')
  await writeFile(path, '{ not json')
  const store = new TagStore(path)
  t.mock.method(console, 'warn', () => {})
  await store.load()
  assert.deepEqual(store.snapshot(), emptyTagState())
  assert.equal((await readdir(dir)).filter(name => name.startsWith('tags.json.unreadable-')).length, 1)
})

test('the route reads state, applies operations and reports rejections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-tags-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TagStore(join(dir, 'tags.json'))
  await store.load()
  const post = (body: string) => handleTagRequest(store, new Request('http://host/api/workspace-tags', { method: 'POST', body }))
  const created = await post(JSON.stringify({ op: 'create', name: 'Docs', color: 'purple', assignTo: 'ws' }))
  assert.equal(created.status, 200)
  const { tag, state } = await created.json() as { tag: { id: string }; state: TagState }
  assert.deepEqual(state.assignments, { ws: [tag.id] })
  const duplicate = await post(JSON.stringify({ op: 'create', name: 'docs', color: 'red' }))
  assert.equal(duplicate.status, 400); assert.match((await duplicate.json() as { error: string }).error, /already exists/)
  assert.equal((await post('{')).status, 400)
  const read = await handleTagRequest(store, new Request('http://host/api/workspace-tags'))
  assert.deepEqual((await read.json() as { state: TagState }).state, store.snapshot())
})
