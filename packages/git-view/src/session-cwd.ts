import { isRemoteAnchor } from './runner.js';

type Lookup = (name: string) => unknown;
type SavedRow = { id: string; cwd?: string } | { header: { id: string; cwd?: string } };
interface Sessions { get?(id: string): { header: { cwd?: string } } | undefined }

/** The directory a conversation started in, from the live session or, before it is opened, from saved sessions. */
export async function sessionCwd(get: Lookup, sessionId: string): Promise<string | undefined> {
  const sessions = get('sessions') as Sessions | undefined;
  const live = sessions?.get?.(sessionId);
  if (live) return live.header.cwd;
  const persistence = get('sessionPersistence') as { list(): Promise<SavedRow[]> } | undefined;
  const stored = (await persistence?.list() ?? []).map(row => 'header' in row ? row.header : row).find(row => row.id === sessionId);
  // A session activated meanwhile is the authority.
  return sessions?.get?.(sessionId)?.header.cwd ?? stored?.cwd;
}

const directory = (value: unknown) => typeof value === 'string' && value !== '' ? value : undefined;

/** DSH's record of where a session moved; undefined when it has none, which leaves the session where it started. */
async function movedTo(get: Lookup, sessionId: string): Promise<string | undefined> {
  try {
    const live = (get('sessions') as Sessions | undefined)?.get?.(sessionId);
    if (live) return directory((get('workingDirectory') as { get?(session: unknown): unknown } | undefined)?.get?.(live));
    const controller = get('sessionController') as { projections?(request: { sessionId: string }, signal: AbortSignal): Promise<{ values?: { workingDirectory?: unknown } } | null> } | undefined;
    return directory((await controller?.projections?.({ sessionId }, AbortSignal.timeout(5000)))?.values?.workingDirectory);
  } catch { return undefined; }
}

/**
 * The directory a conversation works in now. A session that moved, into a worktree or with a `cd`, keeps the project in
 * its header and records the move in DSH's `workingDirectory` projection. A remote workspace stays on its anchor, because
 * Remote Agents finds the machine and folder for Git from the anchor.
 */
export async function workingDirectoryOf(get: Lookup, sessionId: string, isRemote: (cwd: string) => boolean = isRemoteAnchor): Promise<string | undefined> {
  const started = await sessionCwd(get, sessionId);
  if (!started || isRemote(started)) return started;
  return await movedTo(get, sessionId) ?? started;
}
