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
import { UNGROUPED_KEY, type GroupNode, type SessionNode } from '../../src/client/upstream/tree.ts'
import { WorkspaceBrowser } from '../../src/client/upstream/rows/WorkspaceBrowser.tsx'
import { en } from '../../src/client/upstream/locales.ts'
import { createTagRuntime } from '../../src/client/tags/runtime.ts'
import {
  attentionBySpace, inSpace, liveFilter, rowActivity, sectionFolded, sessionActivity, statusSections, tagSections,
} from '../../src/client/tags/sections.ts'
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
  const node = (id: string, overrides: Partial<SessionNode> = {}): SessionNode => ({
    id: sid(id), title: id, blank: false, running: false, runningSubagentCount: 0, completed: false,
    pinned: false, archived: false, updatedAt: 100, ...overrides,
  })
  const waiting = (id: string) => node(id, { pendingInteraction: 'approval' })

  it('lists a Workspace under each of its tags, tags by name, then Untagged', () => {
    const sections = tagSections([group('alpha'), group('beta'), group('gamma'), group(UNGROUPED_KEY)], tagged)
    expect(sections.map(section => [section.key, section.groups.map(g => g.key), section.count])).toEqual([
      ['tag:client', ['alpha', 'beta'], 2],
      ['tag:urgent', ['alpha'], 1],
      ['untagged', ['gamma', UNGROUPED_KEY], 2],
    ])
  })

  it('ranks a Session as its row does: waiting, then running, then an unread completion it can open', () => {
    expect(sessionActivity(node('a', { pendingInteraction: 'question', running: true }))).toBe('waiting')
    expect(sessionActivity(node('b', { running: true, completed: true }))).toBe('running')
    expect(sessionActivity(node('c', { runningSubagentCount: 1 }))).toBe('running')
    expect(sessionActivity(node('d', { completed: true }))).toBe('completed')
    // An archived Session cannot be opened, so its completion would never be read.
    expect(sessionActivity(node('e', { completed: true, archived: true }))).toBeUndefined()
    expect(sessionActivity(node('f'))).toBeUndefined()
    expect(rowActivity([node('g', { running: true }), node('h', { completed: true }), node('i', { completed: true })]))
      .toEqual({ waiting: 0, completed: 2, running: true })
    expect(rowActivity([node('j'), waiting('k')])).toEqual({ waiting: 1, completed: 0, running: false })
    expect(rowActivity([node('l')])).toBeUndefined()
  })

  it('puts a Workspace with any running Session only in Running, ahead of every other state', () => {
    const sessions: Record<string, SessionNode[]> = {
      alpha: [node('a1', { running: true }), waiting('a2'), node('a3')],
      beta: [node('b1', { completed: true }), node('b2', { running: true }), node('b3', { runningSubagentCount: 2 })],
      gamma: [waiting('c1')],
      delta: [node('d1'), node('d2', { completed: true, archived: true }), node('d3', { running: true })],
      epsilon: [],
    }
    const groups = [...['alpha', 'beta', 'gamma', 'epsilon'].map(group), { ...group('delta'), expanded: true, sessions: sessions.delta! }]
    const sections = statusSections(groups, g => sessions[g.key]!)
    expect(sections.map(section => [
      section.kind, section.groups.map(g => [g.key, g.expanded, g.sessions.map(n => n.id)]), section.count,
    ])).toEqual([
      ['waiting', [['gamma', true, ['c1']]], 1],
      ['running', [['alpha', true, ['a1']], ['beta', true, ['b2', 'b3']], ['delta', true, ['d3']]], 4],
      // Idle follows the sidebar's fold, holds Workspaces without Sessions, and counts Workspaces.
      ['idle', [['epsilon', false, []]], 1],
    ])
    expect(sectionFolded({}, 'status:idle')).toBe(true)
    expect(sectionFolded({}, 'status:waiting')).toBe(false)
    expect(sectionFolded({ 'status:idle': false }, 'status:idle')).toBe(false)
  })

  it('counts what needs the user in every space, whatever the filter hides', () => {
    const groups: GroupNode[] = [
      { ...group('alpha'), sessions: [waiting('a1'), node('a2', { completed: true })] },
      { ...group('beta'), sessions: [node('b1', { running: true }), node('b2', { completed: true })] },
      { ...group('gamma'), sessions: [waiting('c1')] },
      { ...group(UNGROUPED_KEY), sessions: [node('u1', { completed: true })] },
    ]
    expect(Object.fromEntries(attentionBySpace(groups, tagged))).toEqual({
      null: { waiting: 2, completed: 3 },
      urgent: { waiting: 1, completed: 1 },
      client: { waiting: 1, completed: 2 },
      unused: { waiting: 0, completed: 0 },
    })
  })

  it('filters to one tag while it exists; the Ungrouped bucket has none', () => {
    expect(liveFilter(tagged, 'client')?.name).toBe('Client')
    expect(liveFilter(tagged, 'deleted')).toBeNull()
    expect(liveFilter(tagged, null)).toBeNull()
    expect([inSpace(tagged, 'client', 'alpha'), inSpace(tagged, 'client', 'gamma'), inSpace(tagged, 'client', undefined)])
      .toEqual([true, false, false])
    expect(inSpace(tagged, null, undefined)).toBe(true)
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

  it('keeps the Group by choice, folds that differ from the default, and the space filter, ignoring what it does not understand', () => {
    localStorage.setItem('dsh-workspace-tags.view.v1', JSON.stringify({
      mode: 'colour', collapsed: { 'tag:a': true, 'tag:b': false, 'status:idle': false, 'status:running': 1, x: 'yes' }, filter: 7,
    }))
    const runtime = createTagRuntime({ fetch: fakeHost().fetch, live: false })
    expect(runtime.view.getSnapshot()).toEqual({ mode: null, collapsed: { 'tag:a': true, 'status:idle': false }, filter: null })
    runtime.setMode('status')
    runtime.setSectionCollapsed('status:idle', true)
    runtime.setSectionCollapsed('tag:a', false)
    runtime.setSectionCollapsed('status:running', true)
    runtime.setFilter('client')
    expect(JSON.parse(localStorage.getItem('dsh-workspace-tags.view.v1')!)).toEqual({
      mode: 'status', collapsed: { 'status:running': true }, filter: 'client',
    })
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
  const section = (label: string) => screen.getAllByRole('group')
    .find(node => node.hasAttribute('data-section-key') && node.getAttribute('aria-label') === label)!
  const sectionHeader = (label: string) => within(section(label)).getAllByRole('button')[0]!
  const sessionTitles = (root: HTMLElement) => within(root).queryAllByRole('treeitem')
    .filter(row => row.hasAttribute('aria-selected')).map(row => within(row).getByText(/^[a-z]\d$/).textContent)
  /** Each section with its Workspaces, and under each Workspace the Session rows that follow it. */
  const sectionSessions = () => screen.queryAllByRole('group').filter(node => node.hasAttribute('data-section-key'))
    .map((node) => {
      const workspaces: [string | undefined, (string | null)[]][] = []
      for (const row of within(node).queryAllByRole('treeitem')) {
        if (row.getAttribute('aria-expanded') !== null) workspaces.push([row.textContent?.match(/alpha|beta|gamma|delta/)?.[0], []])
        else workspaces.at(-1)![1].push(within(row).getByText(/^[a-z]\d$/).textContent)
      }
      return [node.getAttribute('aria-label'), workspaces]
    })
  const chip = (name: RegExp) => within(screen.getByRole('group', { name: 'Show workspaces by tag' })).getByRole('button', { name })

  it('offers Tag and Status beside the stock Group by choices and switches between them', async () => {
    const { runtime, store } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Tag/ }))
    expect(runtime.view.getSnapshot().mode).toBe('tag')
    expect(sectionNames()).toEqual([['Client', ['alpha', 'beta']], ['Urgent', ['alpha']], ['Untagged', ['gamma', 'delta']]])
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Status/ }))
    // What needs the user leads; Idle, the catch-all, starts folded.
    expect(sectionNames()).toEqual([['Waiting for you', ['gamma']], ['Completed', ['delta']], ['Running', ['beta']], ['Idle', []]])
    fireEvent.click(sectionHeader('Idle'))
    expect(sectionNames().at(-1)).toEqual(['Idle', ['alpha']])
    expect(runtime.view.getSnapshot().collapsed).toEqual({ 'status:idle': false })
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
    fireEvent.click(sectionHeader('Idle'))
    expect(sectionNames()).toEqual([['Idle', ['alpha', 'delta']]])
  })

  it('keeps a Workspace with a running Session out of the other Status sections', async () => {
    const { runtime, store } = await mount({
      useSessions: hook(sessionState([summary('a1', { running: true }), summary('a2'), summary('a3'), summary('b1'),
        summary('x1', { origin: 'subagent', running: true })])),
      useSessionStatus: hook(statuses({ a3: { pendingInteraction: approval('a3') }, x1: { running: true, pendingInteraction: approval('x1') } })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1', 'a2', 'a3']), workspace('beta', ['b1'])])),
    })
    act(() => { runtime.setMode('status') })
    expect(store.getSnapshot().groupExpansion).toEqual({})
    // Alpha's waiting and idle Sessions do not give it Waiting or Idle entries while a1 runs.
    expect(sectionSessions()).toEqual([
      ['Running', [['alpha', ['a1']]]],
      ['Idle', []],
    ])
    expect(within(sectionHeader('Idle')).getByText('1')).toBeTruthy()
    expect(within(sectionHeader('Running')).getByText('1')).toBeTruthy()
    // Folding alpha inside Running does not change the sidebar's own Workspace fold.
    fireEvent.click(workspaceRow('alpha')[0]!)
    expect(sectionSessions()[0]).toEqual(['Running', [['alpha', []]]])
    expect(within(workspaceRow('alpha')[0]!).getByRole('img', { name: 'Running' })).toBeTruthy()
    expect(store.getSnapshot().groupExpansion).toEqual({})
    // Only beta, which has no running Session, remains in Idle.
    fireEvent.click(sectionHeader('Idle'))
    expect(sectionNames().at(-1)).toEqual(['Idle', ['beta']])
    expect(workspaceRow('alpha')).toHaveLength(1)
    fireEvent.click(workspaceRow('beta')[0]!)
    expect(store.getSnapshot().groupExpansion).toEqual({ beta: true })
    expect(sectionSessions().at(-1)).toEqual(['Idle', [['beta', ['b1']]]])
  })

  it('unfolds the section that holds a revealed search result', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { runtime } = await mount()
    act(() => { runtime.setMode('status') })
    expect(sectionNames().at(-1)).toEqual(['Idle', []])
    fireEvent.change(screen.getByPlaceholderText('Search session names'), { target: { value: 'a1' } })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(within(screen.getByRole('tree', { name: 'Search results' })).getByRole('treeitem'))
    await waitFor(() => { expect(sectionSessions().at(-1)).toEqual(['Idle', [['alpha', ['a1']]]]) })
    expect(runtime.view.getSnapshot().collapsed).toEqual({ 'status:idle': false })
    expect((scrollIntoView.mock.instances.at(-1) as unknown as HTMLElement).textContent).toContain('a1')
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })

  it('marks a folded Workspace row with the Sessions that need the user, else with a running one', async () => {
    await mount({
      useSessions: hook(sessionState([summary('a1'), summary('b1', { running: true }), summary('c1', { running: true }), summary('c2'), summary('d1')])),
      useSessionStatus: hook(statuses({ c1: { pendingInteraction: approval('c1') }, c2: { completionUnread: true }, d1: { completionUnread: true } })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1']), workspace('beta', ['b1']), workspace('gamma', ['c1', 'c2']), workspace('delta', ['d1'])])),
    })
    const mark = (name: string) => within(workspaceRow(name)[0]!).queryAllByRole('img')
      .filter(img => !img.getAttribute('aria-label')?.startsWith('Tags')).map(img => [img.getAttribute('aria-label'), img.textContent])
    expect(['alpha', 'beta', 'gamma', 'delta'].map(mark)).toEqual([
      [], [['Running', '']], [['1 waiting for you, 1 completed', '2']], [['1 completed', '1']],
    ])
    // Unfolded, the Session rows show their own status.
    fireEvent.click(workspaceRow('gamma')[0]!)
    expect(mark('gamma')).toEqual([])
  })

  it('narrows every grouping to one space and counts what waits in the others', async () => {
    const spaces: TagState = {
      tags: [{ id: 'work', name: 'Work', color: 'blue' }, { id: 'home', name: 'Home', color: 'green' }, { id: 'empty', name: 'Empty', color: 'gray' }],
      assignments: { alpha: ['work'], beta: ['work'], gamma: ['home'], delta: ['home'] },
    }
    const open = vi.fn()
    const { runtime, store } = await mount({ open }, spaces)
    const chips = within(screen.getByRole('group', { name: 'Show workspaces by tag' })).getAllByRole('button')
    expect(chips.map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')])).toEqual([
      ['All', 'true'], ['Empty', 'false'], ['Home, 2 items need you', 'false'], ['Work', 'false'],
    ])
    fireEvent.click(chip(/^Work$/))
    expect(runtime.view.getSnapshot().filter).toBe('work')
    expect(sectionNames()).toEqual([])
    expect(workspaceRow('alpha')).toHaveLength(1)
    expect(['gamma', 'delta'].map(name => workspaceRow(name).length)).toEqual([0, 0])
    expect(chip(/^All/).getAttribute('aria-label')).toBe('All, 2 items need you')
    act(() => { runtime.setMode('status') })
    expect(sectionNames()).toEqual([['Running', ['beta']], ['Idle', []]])
    act(() => { runtime.setMode(null); store.actions.setGroupBy('flat') })
    expect(sessionTitles(screen.getByRole('tree'))).toEqual(['a1', 'b1'])
    // Picking the selected space again shows everything.
    fireEvent.click(chip(/^Work$/))
    expect(sessionTitles(screen.getByRole('tree'))).toEqual(['a1', 'b1', 'c1', 'd1'])
    fireEvent.click(chip(/^Empty$/))
    expect(screen.getByText('No workspaces tagged “Empty”')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(runtime.view.getSnapshot().filter).toBeNull()

    // Search covers every space, and opening a result from another one shows All so the list can reveal it.
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    fireEvent.click(chip(/^Work$/))
    fireEvent.change(screen.getByPlaceholderText('Search session names'), { target: { value: 'c1' } })
    expect(screen.queryByRole('group', { name: 'Show workspaces by tag' })).toBeNull()
    await act(async () => { await Promise.resolve() })
    fireEvent.click(within(screen.getByRole('tree', { name: 'Search results' })).getByRole('treeitem'))
    expect(open).toHaveBeenCalledWith('c1')
    expect(runtime.view.getSnapshot().filter).toBeNull()
    expect((scrollIntoView.mock.instances.at(-1) as unknown as HTMLElement).textContent).toContain('c1')
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })

  it('shows everything when the filtered tag is deleted', async () => {
    const { runtime } = await mount()
    act(() => { runtime.setFilter('unused') })
    expect(screen.getByText('No workspaces tagged “Unused”')).toBeTruthy()
    await act(async () => { await runtime.run({ op: 'delete', id: 'unused' }) })
    expect(['alpha', 'beta', 'gamma', 'delta'].map(name => workspaceRow(name).length)).toEqual([1, 1, 1, 1])
  })

  it('folds sections and keeps Workspace rows out of drag reordering while sectioned', async () => {
    const { runtime } = await mount()
    expect(workspaceRow('alpha')[0]!.getAttribute('draggable')).toBe('true')
    act(() => { runtime.setMode('tag') })
    expect(workspaceRow('alpha').map(row => row.getAttribute('draggable'))).toEqual(['false', 'false'])
    fireEvent.click(sectionHeader('Client'))
    expect(runtime.view.getSnapshot().collapsed).toEqual({ 'tag:client': true })
    expect(sectionNames()).toEqual([['Client', []], ['Urgent', ['alpha']], ['Untagged', ['gamma', 'delta']]])
  })

  it('shows tag dots and opens the tag menu from a right-click or the row menu', async () => {
    const { runtime } = await mount()
    expect(within(workspaceRow('alpha')[0]!).getByRole('img').getAttribute('aria-label')).toBe('Tags: Urgent, Client')
    expect(within(workspaceRow('gamma')[0]!).queryByRole('img', { name: /^Tags/ })).toBeNull()
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
