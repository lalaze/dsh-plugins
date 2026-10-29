/**
 * Workspace tags: free-text names with a palette color, assigned to DSH
 * Workspaces by id. Shared by the host store and the sidebar client; every
 * change goes through {@link applyTagOperation}, so both halves agree on what
 * a valid state is.
 */

/** Host route: GET returns `{ state }`, POST applies one {@link TagOperation} and returns `{ state, tag? }` or `{ error }`. */
export const TAGS_ROUTE = '/api/workspace-tags'

/** Palette ids; the client maps each to a light and a dark color. */
export const TAG_COLORS = [
  'gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink',
  'amber', 'lime', 'emerald', 'cyan', 'sky', 'indigo', 'violet', 'fuchsia', 'rose',
] as const
export type TagColor = typeof TAG_COLORS[number]

export const TAG_NAME_MAX = 40
export const TAG_LIMIT = 200

export interface WorkspaceTag { id: string; name: string; color: TagColor }

/** Tags in creation order, and each Workspace's tag ids in the order they were added. */
export interface TagState { tags: WorkspaceTag[]; assignments: Record<string, string[]> }

export type TagOperation =
  | { op: 'create'; name: string; color: TagColor; assignTo?: string }
  | { op: 'update'; id: string; name?: string; color?: TagColor }
  | { op: 'delete'; id: string }
  /** Toggling one tag at a time keeps two clients' edits to the same Workspace from overwriting each other. */
  | { op: 'assign'; workspaceId: string; tagId: string; assigned: boolean }
  /** Drop a deleted Workspace's assignments. */
  | { op: 'forget'; workspaceId: string }

/** A rejected operation; its message is shown to the user. */
export class TagError extends Error {
  override name = 'TagError'
}

export const emptyTagState = (): TagState => ({ tags: [], assignments: {} })

const isColor = (value: unknown): value is TagColor => (TAG_COLORS as readonly unknown[]).includes(value)
const nameKey = (name: string) => name.normalize('NFC').toLowerCase()
const workspaceId = (value: unknown): string => {
  if (typeof value !== 'string' || value === '' || value.length > 200) throw new TagError('Unknown workspace')
  return value
}

/** Trim and check a tag name; names are unique ignoring case. */
export function tagName(value: unknown, tags: readonly WorkspaceTag[], self?: string): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  if (name === '') throw new TagError('Enter a tag name')
  if ([...name].length > TAG_NAME_MAX) throw new TagError(`Tag names are at most ${TAG_NAME_MAX} characters`)
  const duplicate = tags.find(tag => tag.id !== self && nameKey(tag.name) === nameKey(name))
  if (duplicate) throw new TagError(`A tag named “${duplicate.name}” already exists`)
  return name
}

/**
 * Apply one operation without mutating `state`.
 * @param newId - id for a created tag.
 * @returns the next state and, for `create`, the new tag.
 * @throws TagError when the operation is invalid for this state.
 */
export function applyTagOperation(state: TagState, operation: TagOperation, newId: () => string): { state: TagState; tag?: WorkspaceTag } {
  const tags = state.tags.map(tag => ({ ...tag }))
  const assignments = Object.fromEntries(Object.entries(state.assignments).map(([id, ids]) => [id, [...ids]]))
  const find = (id: unknown) => {
    const tag = tags.find(candidate => candidate.id === id)
    if (!tag) throw new TagError('This tag no longer exists')
    return tag
  }
  switch (operation?.op) {
    case 'create': {
      if (tags.length >= TAG_LIMIT) throw new TagError(`At most ${TAG_LIMIT} tags`)
      if (!isColor(operation.color)) throw new TagError('Choose a tag color')
      const tag: WorkspaceTag = { id: newId(), name: tagName(operation.name, tags), color: operation.color }
      tags.push(tag)
      if (operation.assignTo !== undefined) {
        const target = workspaceId(operation.assignTo)
        assignments[target] = [...assignments[target] ?? [], tag.id]
      }
      return { state: { tags, assignments }, tag }
    }
    case 'update': {
      const tag = find(operation.id)
      if (operation.name !== undefined) tag.name = tagName(operation.name, tags, tag.id)
      if (operation.color !== undefined) {
        if (!isColor(operation.color)) throw new TagError('Choose a tag color')
        tag.color = operation.color
      }
      return { state: { tags, assignments } }
    }
    case 'delete': {
      const tag = find(operation.id)
      for (const [id, ids] of Object.entries(assignments)) {
        const rest = ids.filter(tagId => tagId !== tag.id)
        if (rest.length > 0) assignments[id] = rest
        else delete assignments[id]
      }
      return { state: { tags: tags.filter(candidate => candidate !== tag), assignments } }
    }
    case 'assign': {
      const target = workspaceId(operation.workspaceId)
      const tag = find(operation.tagId)
      const rest = (assignments[target] ?? []).filter(id => id !== tag.id)
      const next = operation.assigned === true ? [...rest, tag.id] : rest
      if (next.length > 0) assignments[target] = next
      else delete assignments[target]
      return { state: { tags, assignments } }
    }
    case 'forget': {
      delete assignments[workspaceId(operation.workspaceId)]
      return { state: { tags, assignments } }
    }
    default:
      throw new TagError('Unknown tag operation')
  }
}

/**
 * Read a stored or received state, dropping what does not fit instead of
 * failing: invalid tags, duplicate names, and assignments to unknown tags.
 */
export function parseTagState(value: unknown): TagState {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const tags: WorkspaceTag[] = []
  for (const raw of Array.isArray(record.tags) ? record.tags : []) {
    const tag = raw as Partial<WorkspaceTag> | null
    if (typeof tag?.id !== 'string' || tag.id === '' || tags.some(t => t.id === tag.id) || !isColor(tag.color)) continue
    try { tags.push({ id: tag.id, name: tagName(tag.name, tags), color: tag.color }) } catch { /* skip invalid names */ }
    if (tags.length === TAG_LIMIT) break
  }
  const known = new Set(tags.map(tag => tag.id))
  const assignments: Record<string, string[]> = {}
  const rawAssignments = typeof record.assignments === 'object' && record.assignments !== null ? record.assignments : {}
  for (const [id, ids] of Object.entries(rawAssignments)) {
    if (id === '' || !Array.isArray(ids)) continue
    const valid = [...new Set(ids.filter((tagId): tagId is string => typeof tagId === 'string' && known.has(tagId)))]
    if (valid.length > 0) assignments[id] = valid
  }
  return { tags, assignments }
}
