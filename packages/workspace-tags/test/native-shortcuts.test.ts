import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from '../src/client/upstream/shortcuts.ts'

function bench(panel: string | null) {
  const commands = new Map<string, any>(), calls: string[] = []
  const ctx = {
    locale: { bind: () => (key: string) => key },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: panel }) } },
    sessions: { list: { getSnapshot: () => ({ byId: { 'local-session': { id: 'local-session', blank: false, retainedBy: { mainView: 1 } } } }) } },
    slots: { entries: () => [{}] },
    shortcuts: { register: (command: any) => { commands.set(command.id, command); return () => {} } },
    effect: (factory: () => unknown) => factory(),
  }
  installWorkspaceShortcuts(ctx as any, { startSession: () => { calls.push('start'); return Promise.resolve('local-new' as any) }, forkSession: async () => { calls.push('fork'); return 'local-fork' as any } }, createWorkspaceShortcutControls(), () => { calls.push('archive') }, () => {})
  const resolve = (name: string) => commands.get(name).resolve({ region: 'page', modal: null, target: null })
  return { resolve, calls }
}

test('remote main panel cannot fork/archive/rename the previously retained local session or invoke local new/add shortcuts', () => {
  const b = bench('device-sync.remote-conversation')
  for (const id of ['session.rename', 'session.fork', 'session.archive', 'session.new', 'workspace.add']) assert.equal(b.resolve(id).status, 'blocked', id)
  assert.equal(b.resolve('session.search').status, 'handled')
  assert.deepEqual(b.calls, [])
})

test('local main conversation retains new, fork, archive, rename and add shortcuts', async () => {
  const b = bench(null)
  for (const id of ['session.rename', 'session.fork', 'session.archive', 'session.new', 'workspace.add']) assert.equal(b.resolve(id).status, 'handled', id)
  b.resolve('session.new').run(); await b.resolve('session.fork').run(); b.resolve('session.archive').run()
  assert.deepEqual(b.calls, ['start', 'fork', 'archive'])
})

test('unrelated global panels retain global new/add but cannot target a hidden local conversation', () => {
  const b = bench('plugins')
  assert.equal(b.resolve('session.new').status, 'handled')
  assert.equal(b.resolve('workspace.add').status, 'handled')
  assert.equal(b.resolve('session.fork').status, 'blocked')
  assert.equal(b.resolve('session.archive').status, 'blocked')
})
