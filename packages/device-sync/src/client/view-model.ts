import { isRemoteBinding, matchingWorkspace, type LocalStatus, type MirrorSessionView, type PeerStatus, type RemoteBinding, type SyncedEvent, type WorkspaceEntry } from '../shared/protocol.js'

/** dsh-workspace-tags' palette ids; several (amber, emerald, sky, rose) are not CSS color names. */
const TAG_COLORS: Record<string, string> = {
  gray: '#8a8f98', red: '#e5484d', orange: '#f76b15', yellow: '#e2a336', green: '#30a46c', teal: '#12a594', blue: '#0090ff', purple: '#8e4ec6', pink: '#d6409f',
  amber: '#ffb224', lime: '#99d52a', emerald: '#3cb179', cyan: '#00a2c7', sky: '#68ddfd', indigo: '#3e63dd', violet: '#6e56cf', fuchsia: '#ab4aba', rose: '#e93d82',
}
export const tagColor = (id: string) => TAG_COLORS[id] ?? TAG_COLORS.gray

export const canCommand = (peer?: PeerStatus) => !!peer?.grantsFromPeer.command && peer.connection !== 'unpaired' && peer.connection !== 'paused'
export const canInteract = (peer?: PeerStatus) => canCommand(peer) && peer?.connection === 'online'
/**
 * Whether group changes to a paired machine's workspaces reach it: it pulls them from here, so an unpaired machine
 * or one this machine does not share with never gets them; a paused or offline one gets them later.
 */
export function groupReach(peer?: PeerStatus): 'blocked-unpaired' | 'blocked-sharing' | 'paused' | 'offline' | 'ok' {
  if (!peer || peer.connection === 'unpaired') return 'blocked-unpaired'
  if (!peer.grantsToPeer.history) return 'blocked-sharing'
  return peer.connection === 'paused' ? 'paused' : peer.connection === 'offline' ? 'offline' : 'ok'
}
export function visibleSessions(sessions: MirrorSessionView[], hidden: boolean, children: boolean) {
  return sessions.filter(s => (hidden || !s.hidden) && (children || s.origin !== 'subagent'))
}
/** Case-insensitive match on title, session id, workspace title and folder; a blank query keeps everything. */
export function matchSessions(sessions: MirrorSessionView[], query: string, workspaceTitle: (session: MirrorSessionView) => string | undefined) {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return sessions
  return sessions.filter(s => [s.title, s.sessionId, workspaceTitle(s), s.cwd].some(value => value?.toLocaleLowerCase().includes(q)))
}
export function mergeEvents(old: SyncedEvent[], next: SyncedEvent[]): SyncedEvent[] {
  return [...new Map([...old, ...next].map(e => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq)
}

/** A definite client rejection did not execute; a timeout may still be ambiguous. */
export function isDefiniteRejection(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408
}

/**
 * Whether a synced session can be carried on here. Undefined unless its workspace is an SSH directory; otherwise
 * that directory, and this machine's workspace for the same directory when there is one.
 */
export function continuation(status: LocalStatus, session: MirrorSessionView): { remote: RemoteBinding; local?: WorkspaceEntry } | undefined {
  const remote = status.workspaces.find(w => w.deviceId === session.deviceId)?.items.find(w => w.workspaceId === session.workspaceId)?.remote
  if (!isRemoteBinding(remote)) return undefined
  const local = matchingWorkspace(remote, status.workspaces.find(w => w.deviceId === status.device.deviceId)?.items ?? [])
  return { remote, ...(local ? { local } : {}) }
}
