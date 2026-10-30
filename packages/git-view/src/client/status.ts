import type { Change, Status } from '../domain.js';
import { git } from './api.js';
import { isRemote, sessionFor } from './sessions.js';

/** VS Code's letters: Modified, Added, Deleted, Renamed, Untracked, and C for a conflict. */
export function statusLetter(code: string): string {
  if (code === '??' || code === '!!') return 'U';
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code)) return 'C';
  if (code.includes('D')) return 'D';
  if (code.includes('R')) return 'R';
  if (code.includes('A') || code.includes('C')) return 'A';
  return 'M';
}
/** VS Code's Git decoration colors, readable in light and dark themes. The dot marks a folder holding changes. */
export const STATUS_COLORS: Record<string, string> = { M: '#e2c08d', A: '#73c991', U: '#73c991', D: '#c74e39', R: '#e2c08d', C: '#e06c75', '•': '#9198a1' };
/** How long a status stays fresh: Git runs locally in milliseconds, but over SSH each refresh is a round trip. */
const FRESH_MS = { local: 3000, remote: 10_000 };
/** A folder whose status could not be read, such as one outside Git, is asked again after this long. */
const RETRY_MS = 60_000;

interface Snapshot { at: number; prefix: string; changes: Change[]; codes: Map<string, string>; folders: Set<string> }
/**
 * Changed files per workspace folder (a conversation's working directory), read synchronously by the change marks and
 * by the diff tab's claim on changed files; requests only refresh it.
 */
export class StatusCache {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  /** Folders asked about recently; only these keep refreshing. */
  private readonly seen = new Map<string, number>();
  private readonly failed = new Map<string, number>();
  constructor(private readonly request: typeof git = git) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  codeOf(root: string, path: string): string | undefined { return this.snapshots.get(root)?.codes.get(path); }
  isChanged(root: string, path: string): boolean { return this.codeOf(root, path) !== undefined; }
  hasChangesUnder(root: string, folder: string): boolean { return !!this.snapshots.get(root)?.folders.has(folder); }
  /** Whether the folder has been read at least once. */
  known(root: string): boolean { return this.snapshots.has(root); }
  /** Roots asked about in the last minute. */
  active(): string[] { const now = Date.now(); return [...this.seen].filter(([, at]) => now - at < 60_000).map(([root]) => root); }
  /** Takes a status read elsewhere, such as with the Git view's overview. */
  set(root: string, status: Pick<Status, 'prefix' | 'changes'>): void {
    const codes = new Map<string, string>(), folders = new Set<string>();
    for (const change of status.changes) {
      if (change.local === undefined) continue;
      codes.set(change.local, change.code);
      for (let at = change.local.lastIndexOf('/'); at > 0; at = change.local.lastIndexOf('/', at - 1)) folders.add(change.local.slice(0, at));
    }
    const previous = this.snapshots.get(root);
    this.snapshots.set(root, { at: Date.now(), prefix: status.prefix, changes: status.changes, codes, folders });
    if (!previous || previous.codes.size !== codes.size || [...codes].some(([path, code]) => previous.codes.get(path) !== code)) for (const listener of [...this.listeners]) listener();
  }
  /** Refreshes the folder's status unless it is fresh; failures, such as a folder outside Git, leave it unchanged. */
  ensure(root: string, fresh = false): Promise<void> {
    if (!root) return Promise.resolve();
    this.seen.set(root, Date.now());
    const held = this.snapshots.get(root);
    if (!fresh && held && Date.now() - held.at < FRESH_MS[isRemote(root) ? 'remote' : 'local']) return Promise.resolve();
    if (!fresh && Date.now() - (this.failed.get(root) ?? -Infinity) < RETRY_MS) return Promise.resolve();
    const running = this.pending.get(root);
    if (running) return running;
    const sessionId = sessionFor(root);
    if (!sessionId) return Promise.resolve();
    const task = this.request<Status>('status', { sessionId }).then(status => { this.failed.delete(root); this.set(root, status); }, () => { this.failed.set(root, Date.now()); })
      .finally(() => { this.pending.delete(root); });
    this.pending.set(root, task);
    return task;
  }
}
