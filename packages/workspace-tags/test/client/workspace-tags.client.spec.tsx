// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteraction, SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { applyTagOperation, emptyTagState, TAGS_ROUTE, type TagOperation, type TagState } from '../../src/shared/tags.ts'
import type { WorkspaceBrowserProps } from '../../src/client/upstream/contract/slots.ts'
import { createWorkspaceShortcutControls } from '../../src/client/upstream/shortcuts.ts'
import { createWorkspaceViewStore } from '../../src/client/upstream/stores.ts'
import { UNGROUPED_KEY, type GroupNode } from '../../src/client/upstream/tree.ts'
import { WorkspaceBrowser } from '../../src/client/upstream/rows/WorkspaceBrowser.tsx'
import { en } from '../../src/client/upstream/locales.ts'
import { createTagRuntime } from '../../src/client/tags/runtime.ts'
import { statusSections, tagSections, workspaceActivity } from '../../src/client/tags/sections.ts'
import { TagDialogOverlay, TagMenuOverlay, type TagOverlayProps } from '../../src/client/tags/overlays.tsx'

const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const t: WorkspaceBrowserProps['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false, updatedAt: 100, retainedBy: {}, ...overrides,
})
const sessionState = (items: readonly SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])), phase: 'ready', projectionsBySession: {},
})
const workspace = (id: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title: id, sessionIds: sessionIds.map(sid),
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (items: readonly WorkspaceView[]): WorkspaceSnapshot => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
})
const statuses = (entries: Record<string, Partial<SessionStatus>>): SessionStatusSnapshot => new Map(Object.entries(entries)
  .map(([id, value]) => [sid(id), { running: false, pendingInteraction: undefined, completionUnread: false, ...value }]))
const approval = (id: string) => ({ key: `approval:${id}`, kind: 'approval', sessionId: sid(id) }) as SessionPendingInteraction
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}
const group = (key: string): GroupNode => ({
  key, workspaceId: key === UNGROUPED_KEY ? undefined : wid(key), cwd: undefined, createdAt: undefined, label: key,
  sessionCount: 0, expanded: false, containsCurrent: false, sessions: [],
})

/** The host route over an in-memory state, using the same operation rules as the real store. */
function fakeHost(initial: TagState = emptyTagState()) {
  let state = initial
  let n = 0
  const operations: TagOperation[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    expect(String(input)).toBe(TAGS_ROUTE)
    if (init?.method !== 'POST') return Response.json({ state })
    const operation = JSON.parse(String(init.body)) as TagOperation
    operations.push(operation)
    try {
      const result = applyTagOperation(state, operation, () => `tag-${++n}`)
      state = result.state
      return Response.json({ state, ...result.tag ? { tag: result.tag } : {} })
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 })
    }
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, operations, state: () => state }
}
const tagged: TagState = {
  tags: [{ id: 'urgent', name: 'Urgent', color: 'red' }, { id: 'client', name: 'Client', color: 'blue' }, { id: 'unused', name: 'Unused', color: 'gray' }],
  assignments: { alpha: ['urgent', 'client'], beta: ['client'], gone: ['urgent'] },
}

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('sections', () => {
  it('lists a Workspace under each of its tags, tags by name, then Untagged', () => {
    const sections = tagSections([group('alpha'), group('beta'), group('gamma'), group(UNGROUPED_KEY)], tagged)
    expect(sections.map(section => [section.key, section.groups.map(g => g.key)])).toEqual([
      ['tag:client', ['alpha', 'beta']],
      ['tag:urgent', ['alpha']],
      ['untagged', ['gamma', UNGROUPED_KEY]],
    ])
  })

  it('groups by what Sessions are doing; waiting on the user and unread completions are their own states', () => {
    const list = sessionState(['a1', 'a2', 'b1', 'b2', 'c1', 'd1', 'e1'].map(id => summary(id, id === 'b1' ? { running: true } : {})))
    const now = statuses({
      a1: { running: true }, a2: { running: true, pendingInteraction: approval('a2') }, b2: { completionUnread: true },
      c1: { pendingInteraction: approval('c1') }, d1: { completionUnread: true },
    })
    const members: Record<string, string[]> = { alpha: ['a1', 'a2'], beta: ['b1', 'b2'], gamma: ['c1'], delta: ['d1'], epsilon: ['e1'] }
    expect(workspaceActivity(members.alpha!.map(sid), list, now)).toEqual({ running: true, waiting: true, completed: false })
    expect(workspaceActivity(members.beta!.map(sid), list, now)).toEqual({ running: true, waiting: false, completed: true })
    expect(workspaceActivity([sid('c1')], list, now)).toEqual({ running: false, waiting: true, completed: false })
    const sections = statusSections(['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(group),
      g => workspaceActivity(members[g.key]!.map(sid), list, now))
    expect(sections.map(section => [section.kind, section.groups.map(g => g.key)])).toEqual([
      ['running', ['alpha', 'beta']], ['waiting', ['alpha', 'gamma']], ['completed', ['beta', 'delta']], ['idle', ['epsilon']],
    ])
  })

  it('counts an unread completion only where it can be read', () => {
    const list = sessionState([summary('open'), summary('archived'), summary('child', { origin: 'subagent' }), summary('again')])
    const done = statuses({ open: { completionUnread: true }, archived: { completionUnread: true }, child: { completionUnread: true }, again: { running: true, completionUnread: true } })
    expect(workspaceActivity([sid('open')], list, done).completed).toBe(true)
    // An archived Session cannot be opened and a subagent has no row, so neither would ever leave Completed.
    expect(workspaceActivity([sid('archived'), sid('child')], list, done, new Set([sid('archived')])).completed).toBe(false)
    // A Session running again counts as running only.
    expect(workspaceActivity([sid('again')], list, done)).toEqual({ running: true, waiting: false, completed: false })
    // Opening the Session clears the flag, and the Workspace is idle.
    expect(workspaceActivity([sid('open')], list, statuses({ open: { completionUnread: false } }))).toEqual({ running: false, waiting: false, completed: false })
  })

  it('counts running subagents of a member Session as running', () => {
    const list: SessionListState = {
      ...sessionState([summary('parent'), summary('child', { origin: 'subagent' })]),
      projectionsBySession: { [sid('parent')]: { values: { subagentCatalog: [{ id: sid('child') }] } } } as unknown as SessionListState['projectionsBySession'],
    }
    expect(workspaceActivity([sid('parent')], list, statuses({ child: { running: true } }))).toEqual({ running: true, waiting: false, completed: false })
  })
})

describe('tag runtime', () => {
  it('loads tags, applies operations and keeps a write over an older refresh', async () => {
    const host = fakeHost(tagged)
    let release!: () => void
    const slow = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'POST') await new Promise<void>((resolve) => { release = resolve })
      return host.fetch(input, init)
    })
    const runtime = createTagRuntime({ fetch: slow as unknown as typeof fetch, live: false })
    expect(runtime.tags.getSnapshot().phase).toBe('loading')
    await runtime.run({ op: 'assign', workspaceId: 'gamma', tagId: 'client', assigned: true })
    release()
    await waitFor(() => { expect(slow).toHaveBeenCalledTimes(2) })
    await act(async () => { await Promise.resolve() })
    expect(runtime.tags.getSnapshot().state.assignments.gamma).toEqual(['client'])
    await expect(runtime.run({ op: 'create', name: 'urgent', color: 'red' })).rejects.toThrow(/already exists/)
  })

  it('keeps the Group by choice and folded sections, ignoring what it does not understand', () => {
    localStorage.setItem('dsh-workspace-tags.view.v1', JSON.stringify({ mode: 'colour', collapsed: { 'tag:a': true, 'tag:b': false, x: 'yes' } }))
    const runtime = createTagRuntime({ fetch: fakeHost().fetch, live: false })
    expect(runtime.view.getSnapshot()).toEqual({ mode: null, collapsed: { 'tag:a': true } })
    runtime.setMode('status')
    runtime.setSectionCollapsed('status:idle', true)
    runtime.setSectionCollapsed('tag:a', false)
    expect(JSON.parse(localStorage.getItem('dsh-workspace-tags.view.v1')!)).toEqual({ mode: 'status', collapsed: { 'status:idle': true } })
  })

  it('forgets a deleted Workspace only when it had tags', async () => {
    const host = fakeHost(tagged)
    const runtime = createTagRuntime({ fetch: host.fetch, live: false })
    await waitFor(() => { expect(runtime.tags.getSnapshot().phase).toBe('ready') })
    runtime.forget('gamma')
    runtime.forget('beta')
    await waitFor(() => { expect(host.state().assignments.beta).toBeUndefined() })
    expect(host.operations).toEqual([{ op: 'forget', workspaceId: 'beta' }])
  })
})

describe('WorkspaceBrowser with tags', () => {
  async function mount(overrides: Partial<WorkspaceBrowserProps> = {}, initial = tagged) {
    const host = fakeHost(initial)
    const runtime = createTagRuntime({ fetch: host.fetch, live: false })
    await waitFor(() => { expect(runtime.tags.getSnapshot().phase).toBe('ready') })
    const controls = createWorkspaceShortcutControls()
    const store = createWorkspaceViewStore().create()
    const props: WorkspaceBrowserProps = {
      useShortcuts: select => select([]),
      useWorkspaceShortcuts: bindSnapshotSelector(controls.state),
      requestSearch: controls.search, requestAddWorkspace: controls.add, closeAddWorkspace: controls.closeAdd,
      setDirectoryBusy: controls.directoryBusy, requestSessionRename: controls.rename,
      wide: true, expandSidebar: vi.fn(),
      useSessions: hook(sessionState([summary('a1'), summary('b1', { running: true }), summary('c1'), summary('d1')])),
      useSessionStatus: hook(statuses({ c1: { pendingInteraction: approval('c1') }, d1: { completionUnread: true } })),
      useSessionRetainInfo: () => undefined, usePanelInfo,
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1']), workspace('beta', ['b1']), workspace('gamma', ['c1']), workspace('delta', ['d1'])])),
      ...allowAllAccess,
      useStore: bindSnapshotSelector(store), actions: store.actions,
      startSession: vi.fn(), open: vi.fn(),
      searchSessions: vi.fn(async () => ({ items: [], hasMore: false })), searchResultLimit: 20,
      notifyArchivedNotOpenable: vi.fn(),
      renameWorkspace: vi.fn(async () => {}), deleteWorkspace: vi.fn(async () => {}),
      unarchiveSession: vi.fn(async () => {}), insertWorkspaceBefore: vi.fn(async () => {}),
      createWorkspace: vi.fn(async () => workspace('created', [])),
      useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
      useHostInfo: selector => selector({ home: undefined, isLoopback: true }),
      renderSlot: () => null,
      tagging: runtime,
      t,
      ...overrides,
    }
    render(<WorkspaceBrowser {...props} />)
    return { runtime, host, store, props }
  }
  const workspaceRow = (name: string) => screen.getAllByRole('treeitem').filter(row => row.getAttribute('aria-expanded') !== null
    && within(row).queryByText(name) !== null)
  const sectionNames = () => screen.queryAllByRole('group').filter(node => node.hasAttribute('data-section-key'))
    .map(node => [node.getAttribute('aria-label'), workspaceNames(node)])
  const workspaceNames = (root: HTMLElement) => within(root).queryAllByRole('treeitem')
    .filter(row => row.getAttribute('aria-expanded') !== null).map(row => row.textContent?.match(/alpha|beta|gamma|delta/)?.[0])

  it('offers Tag and Status beside the stock Group by choices and switches between them', async () => {
    const { runtime, store } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Tag/ }))
    expect(runtime.view.getSnapshot().mode).toBe('tag')
    expect(sectionNames()).toEqual([['Client', ['alpha', 'beta']], ['Urgent', ['alpha']], ['Untagged', ['gamma', 'delta']]])
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Status/ }))
    expect(sectionNames()).toEqual([['Running', ['beta']], ['Waiting for you', ['gamma']], ['Completed', ['delta']], ['Idle', ['alpha']]])
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^In one list/ }))
    expect(runtime.view.getSnapshot().mode).toBeNull()
    expect(store.getSnapshot().groupBy).toBe('flat')
    expect(sectionNames()).toEqual([])
  })

  it('leaves a Workspace whose only unread completion is archived in Idle', async () => {
    const { runtime } = await mount({
      useSessions: hook(sessionState([summary('a1'), summary('d1')])),
      useWorkspaces: hook({ ...workspaceState([workspace('alpha', ['a1']), workspace('delta', ['d1'])]), archivedSessionIds: [sid('d1')] }),
    })
    act(() => { runtime.setMode('status') })
    expect(sectionNames()).toEqual([['Idle', ['alpha', 'delta']]])
  })

  it('folds sections and keeps Workspace rows out of drag reordering while sectioned', async () => {
    const { runtime } = await mount()
    expect(workspaceRow('alpha')[0]!.getAttribute('draggable')).toBe('true')
    act(() => { runtime.setMode('tag') })
    expect(workspaceRow('alpha').map(row => row.getAttribute('draggable'))).toEqual(['false', 'false'])
    fireEvent.click(screen.getByRole('button', { name: /Client/ }))
    expect(runtime.view.getSnapshot().collapsed).toEqual({ 'tag:client': true })
    expect(sectionNames()).toEqual([['Client', []], ['Urgent', ['alpha']], ['Untagged', ['gamma', 'delta']]])
  })

  it('shows tag dots and opens the tag menu from a right-click or the row menu', async () => {
    const { runtime } = await mount()
    expect(within(workspaceRow('alpha')[0]!).getByRole('img').getAttribute('aria-label')).toBe('Tags: Urgent, Client')
    expect(within(workspaceRow('gamma')[0]!).queryByRole('img')).toBeNull()
    fireEvent.contextMenu(workspaceRow('beta')[0]!, { clientX: 40, clientY: 90 })
    expect(runtime.menu.getSnapshot()).toEqual({ workspaceId: 'beta', anchor: { x: 40, y: 90, width: 0, height: 0 } })
    act(() => { runtime.openMenu(null) })
    fireEvent.click(within(workspaceRow('gamma')[0]!).getByRole('button', { name: 'Workspace actions for gamma' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Tags…/ }))
    expect(runtime.menu.getSnapshot()?.workspaceId).toBe('gamma')
  })
})

describe('tag overlays', () => {
  async function overlays(initial = tagged) {
    const host = fakeHost(initial)
    const runtime = createTagRuntime({ fetch: host.fetch, live: false })
    await waitFor(() => { expect(runtime.tags.getSnapshot().phase).toBe('ready') })
    const props = {
      useTagMenu: bindSnapshotSelector(runtime.menu),
      useTagDialog: bindSnapshotSelector(runtime.dialog),
      useWorkspaceTags: bindSnapshotSelector(runtime.tags),
      useWorkspaces: hook(workspaceState([workspace('alpha', []), workspace('beta', [])])),
      run: runtime.run, openMenu: runtime.openMenu, openDialog: runtime.openDialog, t,
    } as unknown as TagOverlayProps
    render(<><TagMenuOverlay {...props} /><TagDialogOverlay {...props} /></>)
    return { runtime, host }
  }

  it('toggles tags from the menu without closing it', async () => {
    const { runtime, host } = await overlays()
    act(() => { runtime.openMenu({ workspaceId: 'beta', anchor: { x: 10, y: 10, width: 0, height: 0 } }) })
    expect(await screen.findByText('Tags for beta')).toBeTruthy()
    // Menu marks selected rows with a trailing check, as DSH's own Group by menu does.
    const checked = (name: RegExp) => screen.getByRole('menuitem', { name }).querySelector('svg') !== null
    expect([checked(/Client/), checked(/Urgent/)]).toEqual([true, false])
    fireEvent.click(screen.getByRole('menuitem', { name: /Urgent/ }))
    expect(checked(/Urgent/)).toBe(true)
    await waitFor(() => { expect(host.state().assignments.beta).toEqual(['client', 'urgent']) })
    expect(runtime.menu.getSnapshot()).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Client/ }))
    await waitFor(() => { expect(host.state().assignments.beta).toEqual(['urgent']) })
  })

  it('creates a tag for the Workspace it was asked from', async () => {
    const { runtime, host } = await overlays()
    act(() => { runtime.openMenu({ workspaceId: 'beta', anchor: { x: 10, y: 10, width: 0, height: 0 } }) })
    fireEvent.click(await screen.findByRole('menuitem', { name: /New tag…/ }))
    expect(runtime.menu.getSnapshot()).toBeNull()
    const name = await screen.findByRole('textbox', { name: 'Tag name' })
    expect(screen.getByText('Will be added to “beta”')).toBeTruthy()
    fireEvent.change(name, { target: { value: 'client' } })
    expect(screen.getByRole('alert').textContent).toBe('A tag named “client” already exists')
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(name, { target: { value: 'Docs' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Purple' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => { expect(runtime.dialog.getSnapshot()).toBeNull() })
    expect(host.operations).toEqual([{ op: 'create', name: 'Docs', color: 'purple', assignTo: 'beta' }])
    expect(host.state().assignments.beta).toEqual(['client', 'tag-1'])
  })

  it('manages tags: counts live Workspaces, edits, and deletes after confirming', async () => {
    const { runtime, host } = await overlays()
    act(() => { runtime.openDialog({ kind: 'manage' }) })
    const row = (name: string) => screen.getByText(name).closest('li')!
    // `gone` is not a Workspace any more, so Urgent counts only alpha.
    expect(within(row('Urgent')).getByText('1 workspace')).toBeTruthy()
    expect(within(row('Client')).getByText('2 workspaces')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit “Unused”' }))
    const name = await screen.findByRole('textbox', { name: 'Tag name' })
    fireEvent.change(name, { target: { value: 'Later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(runtime.dialog.getSnapshot()).toEqual({ kind: 'manage' }) })
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Urgent”' }))
    expect(host.operations.some(operation => operation.op === 'delete')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(host.state().tags.map(tag => tag.name)).toEqual(['Client', 'Later']) })
    expect(host.state().assignments).toEqual({ alpha: ['client'], beta: ['client'] })
  })
})
