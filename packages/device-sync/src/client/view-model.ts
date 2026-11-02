import type { MirrorSessionView, PeerStatus, SyncedEvent } from '../shared/protocol.js'

/** dsh-workspace-tags' palette ids; several (amber, emerald, sky, rose) are not CSS color names. */
const TAG_COLORS: Record<string, string> = {
  gray: '#8a8f98', red: '#e5484d', orange: '#f76b15', yellow: '#e2a336', green: '#30a46c', teal: '#12a594', blue: '#0090ff', purple: '#8e4ec6', pink: '#d6409f',
  amber: '#ffb224', lime: '#99d52a', emerald: '#3cb179', cyan: '#00a2c7', sky: '#68ddfd', indigo: '#3e63dd', violet: '#6e56cf', fuchsia: '#ab4aba', rose: '#e93d82',
}
export const tagColor = (id: string) => TAG_COLORS[id] ?? TAG_COLORS.gray

export const canCommand = (peer?: PeerStatus) => !!peer?.grantsFromPeer.command && peer.connection !== 'unpaired' && peer.connection !== 'paused'
export const canInteract = (peer?: PeerStatus) => canCommand(peer) && peer?.connection === 'online'
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
