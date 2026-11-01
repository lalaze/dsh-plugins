/**
 * Groups (dsh-workspace-tags tags) shared between machines, merged field by field.
 *
 * Every field is a register: a value, the hybrid-clock stamp of the write that set it, and the device that wrote it.
 * A merge keeps the later write. When both machines changed the same field since they last agreed on it, the later
 * write still wins, so both converge, but the other value is kept as a conflict for the user to pick from.
 *
 * Register keys:
 * - `tag|<tagId>|name`, `tag|<tagId>|color`, `tag|<tagId>|order`, `tag|<tagId>|deleted`
 * - `assign|<tagId>|<device>:<workspace>`: whether the workspace has the tag
 * - `link|<ref>|<ref>`: whether two workspaces of different machines are the same project (refs sorted)
 */
import type { GroupConflict, GroupsView, GroupTag } from '../shared/protocol.js'

export interface Register { v: unknown; t: string; d: string }
export type Registers = Record<string, Register>

/** dsh-workspace-tags' state; kept structurally so this package does not depend on it. */
export interface TagState { tags: { id: string; name: string; color: string }[]; assignments: Record<string, string[]> }

/** dsh-workspace-tags' palette (0.1.9). A color it does not know would make it drop the tag, so those show as gray. */
const TAG_COLORS = new Set(['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink',
  'amber', 'lime', 'emerald', 'cyan', 'sky', 'indigo', 'violet', 'fuchsia', 'rose'])
const TAG_NAME_MAX = 40

/** Hybrid logical clock: wall time when it moves forward, a counter otherwise. Stamps sort as strings. */
export class Clock {
  private ms = 0
  private counter = 0
  constructor(private readonly deviceId: string, last?: string, private readonly time: () => number = Date.now) { if (last) this.observe(last) }
  now(): string {
    const wall = this.time()
    if (wall > this.ms) { this.ms = wall; this.counter = 0 } else this.counter++
    return this.format()
  }
  /** Move past a stamp seen from another machine, so this machine's next write sorts after it. */
  observe(stamp: string): void {
    const [ms, counter] = stamp.split('.').map(Number)
    if (!Number.isFinite(ms) || !Number.isFinite(counter)) return
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) { this.ms = ms; this.counter = counter }
  }
  last(): string { return this.format() }
  private format() { return `${String(this.ms).padStart(15, '0')}.${String(this.counter).padStart(6, '0')}.${this.deviceId}` }
}

interface StoredConflict extends GroupConflict { stamps: [string, string] }

export interface GroupsData {
  registers: Registers
  /** Per peer, the stamp of each register both machines last agreed on. */
  agreed: Record<string, Record<string, string>>
  conflicts: Record<string, StoredConflict>
  /** The tags state this machine last wrote to or read from dsh-workspace-tags. */
  projected?: TagState
  clock?: string
}

export const emptyGroups = (): GroupsData => ({ registers: {}, agreed: {}, conflicts: {} })

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const tagKey = (id: string, field: 'name' | 'color' | 'order' | 'deleted') => `tag|${id}|${field}`
const assignKey = (tagId: string, ref: string) => `assign|${tagId}|${ref}`
export const linkKey = (a: string, b: string) => { const [x, y] = [a, b].sort(); return `link|${x}|${y}` }
const nameKey = (name: string) => name.normalize('NFC').toLowerCase()

export class Groups {
  readonly clock: Clock
  constructor(readonly data: GroupsData, private readonly deviceId: string, deviceNames: () => Record<string, string> = () => ({})) {
    this.clock = new Clock(deviceId, data.clock)
    for (const register of Object.values(data.registers)) this.clock.observe(register.t)
    this.names = deviceNames
  }
  private readonly names: () => Record<string, string>

  private write(key: string, value: unknown): boolean {
    const current = this.data.registers[key]
    if (current && same(current.v, value)) return false
    this.data.registers[key] = { v: value, t: this.clock.now(), d: this.deviceId }
    delete this.data.conflicts[key]
    this.data.clock = this.clock.last()
    return true
  }

  /** Set one register from this machine, e.g. a tag on another machine's workspace. Returns whether it changed. */
  set(key: string, value: unknown): boolean { return this.write(key, value) }

  /**
   * Record what changed in this machine's dsh-workspace-tags since it was last read or written. Only assignments of
   * this machine's own workspaces are taken from it.
   * @returns whether any register changed.
   */
  observeLocal(current: TagState): boolean {
    const before = this.data.projected ?? { tags: [], assignments: {} }
    let changed = false
    const previous = new Map(before.tags.map(tag => [tag.id, tag]))
    let order = Math.max(0, ...Object.entries(this.data.registers).filter(([key]) => key.endsWith('|order')).map(([, r]) => Number(r.v) || 0))
    for (const tag of current.tags) {
      const old = previous.get(tag.id)
      if (!old) {
        changed = this.write(tagKey(tag.id, 'name'), tag.name) || changed
        changed = this.write(tagKey(tag.id, 'color'), tag.color) || changed
        if (!this.data.registers[tagKey(tag.id, 'order')]) changed = this.write(tagKey(tag.id, 'order'), ++order) || changed
        changed = this.write(tagKey(tag.id, 'deleted'), false) || changed
        continue
      }
      if (old.name !== tag.name) changed = this.write(tagKey(tag.id, 'name'), tag.name) || changed
      if (old.color !== tag.color) changed = this.write(tagKey(tag.id, 'color'), tag.color) || changed
    }
    const kept = new Set(current.tags.map(tag => tag.id))
    for (const tag of before.tags) if (!kept.has(tag.id)) changed = this.write(tagKey(tag.id, 'deleted'), true) || changed
    const pairs = (state: TagState) => new Set(Object.entries(state.assignments).flatMap(([ws, ids]) => ids.map(id => `${id}|${ws}`)))
    const now = pairs(current), was = pairs(before)
    for (const pair of now) if (!was.has(pair)) { const [id, ws] = pair.split('|'); changed = this.write(assignKey(id, `${this.deviceId}:${ws}`), true) || changed }
    for (const pair of was) if (!now.has(pair)) { const [id, ws] = pair.split('|'); changed = this.write(assignKey(id, `${this.deviceId}:${ws}`), false) || changed }
    this.data.projected = structuredClone(current)
    return changed
  }

  /** Registers to send to a peer. */
  registers(): Registers { return this.data.registers }

  /**
   * Merge a peer's registers.
   * @returns whether anything here changed.
   */
  merge(peerId: string, remote: Registers): boolean {
    const agreed = this.data.agreed[peerId] ??= {}
    let changed = false
    for (const [key, theirs] of Object.entries(remote)) {
      if (!isRegister(theirs)) continue
      this.clock.observe(theirs.t)
      const ours = this.data.registers[key]
      if (!ours) { this.data.registers[key] = theirs; agreed[key] = theirs.t; changed = true; continue }
      if (ours.t === theirs.t) { agreed[key] = ours.t; continue }
      const base = agreed[key]
      const [winner, loser] = ours.t > theirs.t ? [ours, theirs] : [theirs, ours]
      const concurrent = (base === undefined || (ours.t > base && theirs.t > base)) && !same(ours.v, theirs.v)
      if (concurrent) {
        this.data.conflicts[key] = { key, label: '', kept: winner.v, other: loser.v, keptFrom: winner.d, otherFrom: loser.d, at: Date.now(), stamps: [ours.t, theirs.t] }
      } else if (this.data.conflicts[key] && this.data.conflicts[key].stamps.every(stamp => winner.t > stamp)) {
        // A later write, such as the other machine resolving the conflict, settles it here too.
        delete this.data.conflicts[key]
      }
      if (winner !== ours) { this.data.registers[key] = winner; changed = true }
      agreed[key] = winner.t
    }
    this.data.clock = this.clock.last()
    return changed
  }

  /** Forget what was agreed with a machine that is no longer paired. */
  forgetPeer(peerId: string): void { delete this.data.agreed[peerId] }

  /** Pick a conflict's value. Keeping the current value also counts as a new write, so the other machine settles too. */
  resolve(key: string, useOther: boolean): boolean {
    const conflict = this.data.conflicts[key]
    if (!conflict) return false
    const value = useOther ? conflict.other : conflict.kept
    this.data.registers[key] = { v: value, t: this.clock.now(), d: this.deviceId }
    delete this.data.conflicts[key]
    this.data.clock = this.clock.last()
    return true
  }

  /** Merged tags in display order, with names made unique the way dsh-workspace-tags requires. */
  tags(): GroupTag[] {
    const byId = new Map<string, Partial<Record<'name' | 'color' | 'order' | 'deleted', unknown>>>()
    for (const [key, register] of Object.entries(this.data.registers)) {
      const [kind, id, field] = key.split('|')
      if (kind !== 'tag' || !id || !field) continue
      const entry = byId.get(id) ?? {}
      entry[field as 'name'] = register.v
      byId.set(id, entry)
    }
    const tags = [...byId.entries()]
      .filter(([, t]) => t.deleted !== true && typeof t.name === 'string' && t.name.trim() !== '')
      .map(([id, t]) => ({ id, name: String(t.name).trim(), color: TAG_COLORS.has(String(t.color)) ? String(t.color) : 'gray', order: Number(t.order) || 0 }))
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
    const used = new Set<string>()
    for (const tag of tags) {
      let name = [...tag.name].slice(0, TAG_NAME_MAX).join(''), n = 2
      while (used.has(nameKey(name))) {
        const suffix = ` (${n++})`
        name = [...tag.name].slice(0, TAG_NAME_MAX - suffix.length).join('') + suffix
      }
      used.add(nameKey(name))
      tag.name = name
    }
    return tags
  }

  /** Workspace reference → tag ids, for every machine's workspaces. */
  assignments(): Record<string, string[]> {
    const live = new Set(this.tags().map(tag => tag.id))
    const result: Record<string, string[]> = {}
    const entries = Object.entries(this.data.registers).filter(([key, r]) => key.startsWith('assign|') && r.v === true)
      .sort(([, a], [, b]) => (a.t < b.t ? -1 : 1))
    for (const [key] of entries) {
      const [, tagId, ref] = key.split('|')
      if (live.has(tagId)) (result[ref] ??= []).push(tagId)
    }
    return result
  }

  links(): [string, string][] {
    return Object.entries(this.data.registers).filter(([key, r]) => key.startsWith('link|') && r.v === true)
      .map(([key]) => { const [, a, b] = key.split('|'); return [a, b] as [string, string] })
  }

  /** The state dsh-workspace-tags should hold here: every merged tag, and this machine's own workspaces' assignments. */
  project(): TagState {
    const prefix = `${this.deviceId}:`
    const assignments: Record<string, string[]> = {}
    for (const [ref, ids] of Object.entries(this.assignments())) if (ref.startsWith(prefix)) assignments[ref.slice(prefix.length)] = ids
    return { tags: this.tags().map(({ id, name, color }) => ({ id, name, color })), assignments }
  }

  /** Note what was written to dsh-workspace-tags, so it is not mistaken for a local edit. */
  projected(state: TagState): void { this.data.projected = structuredClone(state) }

  view(tagsPlugin: boolean): GroupsView {
    const names = this.names()
    const tagNames = new Map(this.tags().map(tag => [tag.id, tag.name]))
    const conflicts = Object.values(this.data.conflicts).map(({ stamps: _stamps, ...conflict }) => ({
      ...conflict, label: conflictLabel(conflict.key, tagNames), keptFrom: names[conflict.keptFrom] ?? conflict.keptFrom, otherFrom: names[conflict.otherFrom] ?? conflict.otherFrom,
    }))
    return { tags: this.tags(), assignments: this.assignments(), links: this.links(), conflicts, tagsPlugin }
  }
}

function conflictLabel(key: string, tagNames: Map<string, string>): string {
  const [kind, id, field] = key.split('|')
  const name = tagNames.get(id) ?? id
  if (kind === 'tag') return field === 'name' ? `Group “${name}” name` : field === 'color' ? `Group “${name}” color` : field === 'deleted' ? `Group “${name}” deleted` : `Group “${name}” order`
  if (kind === 'assign') return `Group “${name}” on a workspace`
  return 'Linked workspaces'
}

const isRegister = (value: unknown): value is Register => typeof value === 'object' && value !== null
  && typeof (value as Register).t === 'string' && typeof (value as Register).d === 'string' && 'v' in value
