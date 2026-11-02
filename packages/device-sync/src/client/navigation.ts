/** DSH's conversation navigation (`uiWorkspace`), handed over by the client entry. */
type Navigation = { openSession?(sessionId: string): void }
let navigation: (() => Navigation | undefined) | undefined
const opened = new Set<() => void>()

export function setNavigation(get: () => Navigation | undefined): () => void {
  navigation = get
  return () => { if (navigation === get) navigation = undefined }
}

/** Show one of this machine's sessions in DSH's conversation view; false when this DSH offers no way to. */
export function openLocalSession(sessionId: string): boolean {
  const target = navigation?.()
  if (!target?.openSession) return false
  target.openSession(sessionId)
  for (const listener of opened) listener()
  return true
}

/** Run `listener` after a session was opened, such as to close a dialog in front of it. */
export function onSessionOpened(listener: () => void): () => void {
  opened.add(listener)
  return () => { opened.delete(listener) }
}
