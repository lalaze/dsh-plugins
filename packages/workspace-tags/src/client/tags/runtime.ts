/**
 * Client tag runtime: reads and changes tags through the host route, keeps
 * the Group by choice and folded sections in localStorage, and carries the
 * open menu and dialog requests between the sidebar and its overlays.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { emptyTagState, parseTagState, TAGS_ROUTE, type TagOperation, type WorkspaceTag } from '../../shared/tags.ts'
import type { SectionMode, TagDialogRequest, TagMenuRequest, TagRuntime, TagSnapshot, TagViewState } from './contract.ts'

/** Other clients of the same host (desktop and remote web) can change tags. */
const REFRESH_MS = 30_000
const VIEW_KEY = 'dsh-workspace-tags.view.v1'

const isMode = (value: unknown): value is SectionMode => value === 'tag' || value === 'status'

export interface TagRuntimeOptions {
  fetch?: typeof fetch
  /** Window events and the refresh timer; omitted in tests. */
  live?: boolean
}

export function createTagRuntime(options: TagRuntimeOptions = {}): TagRuntime & { dispose(): void } {
  const request = options.fetch ?? ((input, init) => fetch(input, init))
  const tags = createSnapshotStore<TagSnapshot>({ phase: 'loading', state: emptyTagState() }, { flush: 'sync' })
  const view = createSnapshotStore<TagViewState>({ mode: null, collapsed: {} }, { flush: 'sync', persist: { name: VIEW_KEY } })
  // A blob from another version may hold anything; keep only what this one understands.
  const stored = view.getSnapshot() as Partial<TagViewState> | null
  view.set({
    mode: isMode(stored?.mode) ? stored.mode : null,
    collapsed: Object.fromEntries(Object.entries(stored?.collapsed ?? {}).filter(([, value]) => value === true)),
  })
  const menu = createSnapshotStore<TagMenuRequest | null>(null, { flush: 'sync' })
  const dialog = createSnapshotStore<TagDialogRequest | null>(null, { flush: 'sync' })

  // A refresh started before a write must not replace the write's newer state.
  let generation = 0
  const refresh = async (): Promise<void> => {
    const current = ++generation
    try {
      const response = await request(TAGS_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { state?: unknown }
      if (current === generation) tags.set({ phase: 'ready', state: parseTagState(body.state) })
    } catch (error) {
      if (current !== generation) return
      if (tags.getSnapshot().phase === 'loading') tags.set({ ...tags.getSnapshot(), phase: 'error' })
      console.warn('[dsh-workspace-tags] Could not load tags', error)
    }
  }
  const run = async (operation: TagOperation): Promise<WorkspaceTag | undefined> => {
    const response = await request(TAGS_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
    })
    const body = await response.json().catch(() => ({})) as { state?: unknown; tag?: WorkspaceTag; error?: unknown }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not save tags')
    generation++
    tags.set({ phase: 'ready', state: parseTagState(body.state) })
    return body.tag
  }

  const disposers: (() => void)[] = []
  void refresh()
  if (options.live !== false && typeof window !== 'undefined') {
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(onVisible, REFRESH_MS)
    disposers.push(() => {
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    })
  }

  return {
    tags, view, menu, dialog, run,
    setMode: mode => { view.update((draft) => { draft.mode = mode }) },
    setSectionCollapsed: (key, collapsed) => {
      view.update((draft) => {
        if (collapsed) draft.collapsed[key] = true
        else delete draft.collapsed[key]
      })
    },
    openMenu: next => { menu.set(next) },
    openDialog: next => { dialog.set(next) },
    forget: (workspaceId) => {
      if (!(workspaceId in tags.getSnapshot().state.assignments)) return
      run({ op: 'forget', workspaceId }).catch((error: unknown) => {
        console.warn('[dsh-workspace-tags] Could not remove a deleted workspace\'s tags', error)
      })
    },
    dispose: () => { for (const dispose of disposers.splice(0)) dispose() },
  }
}
