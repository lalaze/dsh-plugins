/** What the sidebar fork and the tag overlays share about tags. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TagOperation, TagState, WorkspaceTag } from '../../shared/tags.ts'

/** Extra Group by choices layered over ui-workspace's own `groupBy`. */
export type SectionMode = 'tag' | 'status'

export interface TagSnapshot {
  /** `error` only before the first successful read; later failures keep the last state. */
  phase: 'loading' | 'ready' | 'error'
  state: TagState
}

export interface TagViewState {
  /** Null leaves ui-workspace's own Group by choice in charge. */
  mode: SectionMode | null
  /** Sections folded or unfolded against their default (see `sectionFolded`), by section key. */
  collapsed: Record<string, boolean>
  /** The space filter: the one tag whose Workspaces every grouping shows, or null for all. */
  filter: string | null
}

/** Where the tag menu opens: a right-click point or a menu button's box. */
export interface TagMenuAnchor { x: number; y: number; width: number; height: number }
export interface TagMenuRequest { workspaceId: string; anchor: TagMenuAnchor }

export type TagDialogRequest =
  | { kind: 'create'; assignTo?: string | undefined; workspaceTitle?: string | undefined }
  | { kind: 'edit'; tagId: string; back?: 'manage' | undefined }
  | { kind: 'manage' }

/** Host-side tag operations plus the surfaces' shared requests. */
export interface TagRuntime {
  tags: HostObservable<TagSnapshot>
  view: HostObservable<TagViewState>
  menu: HostObservable<TagMenuRequest | null>
  dialog: HostObservable<TagDialogRequest | null>
  run(operation: TagOperation): Promise<WorkspaceTag | undefined>
  setMode(mode: SectionMode | null): void
  setSectionCollapsed(key: string, collapsed: boolean): void
  setFilter(tagId: string | null): void
  openMenu(request: TagMenuRequest | null): void
  openDialog(request: TagDialogRequest | null): void
  /** Drop a deleted Workspace's tags; failures only log. */
  forget(workspaceId: string): void
}
