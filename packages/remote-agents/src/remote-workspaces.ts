import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RemoteError, remotePath, sharesSessions, type RemoteWorkspace } from './domain.js';
import type { RemoteAgentsService } from './service.js';
import { dshHome, sameEndpoint, sshEndpoint, under, type Endpoint, type WorkspaceAccess } from './workspace-access.js';

/** dsh-remote's anchor format: either plugin finds and reuses the other's workspace folders. */
const META = '.dsh-remote-meta.json';

/** dsh-remote's POSIX normalization: `.` and `..` segments resolve lexically. */
export function normalizeRemotePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop(); else parts.push(segment);
  }
  return `/${parts.join('/')}`;
}
/** dsh-remote's 32-bit string hash, which separates folders whose basenames are equal. */
export function shortHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}
/** Shorten `base` so that `base + suffix` fits one 255-byte path segment, without splitting a character. */
function segment(base: string, suffix = ''): string {
  let budget = 255 - Buffer.byteLength(suffix), kept = '';
  for (const char of base) {
    budget -= Buffer.byteLength(char);
    if (budget < 0) break;
    kept += char;
  }
  return kept + suffix;
}
/**
 * Anchor folders a remote directory may use, in dsh-remote's order: the basename, then basename-hash.
 * Names that fit one path segment match dsh-remote's; longer ones, which dsh-remote cannot create, are shortened.
 */
export function anchorCandidates(home: string, endpoint: Endpoint, path: string): string[] {
  const tag = segment([endpoint.host, endpoint.username, endpoint.port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (!tag || tag === '.' || tag === '..') throw new RemoteError('Invalid workspace machine address');
  // dsh-remote also splits on backslashes, so a POSIX name such as `a\..` must not escape the machine folder.
  const name = path.split(/[\\/]/).pop(), base = name && name !== '.' && name !== '..' ? name : 'workspace';
  const root = join(home, 'remote-workspaces', tag);
  return [join(root, segment(base)), join(root, segment(base, `-${shortHash(path)}`))];
}
async function readAnchor(dir: string): Promise<Record<string, unknown> | 'missing' | undefined> {
  try { if (!(await lstat(dir)).isDirectory()) return undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  try {
    const meta: unknown = JSON.parse(await readFile(join(dir, META), 'utf8'));
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
/**
 * Publish a complete anchor at `dir` in one step: the folder appears with its metadata or not at all.
 * Returns false when something already occupies `dir`, possibly a concurrent creation.
 */
async function claimAnchor(dir: string, meta: Record<string, unknown>): Promise<boolean> {
  // A fixed-length name: the anchor's own name may already use the whole segment.
  const staging = join(dirname(dir), `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(join(staging, META), JSON.stringify(meta, null, 2), { mode: 0o600, flag: 'wx' });
    // Renaming onto an existing folder fails unless it is empty; an anchor always holds its metadata.
    try { await rename(staging, dir); return true; }
    catch (error) { if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return false; throw error; }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
/** Create or reuse the local folder DSH adopts as the workspace for `remote` on `endpoint`. */
export async function ensureAnchor(home: string, endpoint: Endpoint, remote: string): Promise<string> {
  const path = normalizeRemotePath(remotePath(remote));
  const matches = (meta: Record<string, unknown>) => {
    const port = meta.port ?? 22;
    return meta.remotePath === path && typeof meta.host === 'string' && typeof meta.username === 'string' && typeof port === 'number'
      && sameEndpoint(endpoint, { host: meta.host, username: meta.username, port });
  };
  for (const dir of anchorCandidates(home, endpoint, path)) {
    // A lost race re-reads the winner's binding; a few attempts cover a folder removed meanwhile.
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = await readAnchor(dir);
      if (meta !== 'missing') { if (meta && matches(meta)) return dir; break; }
      await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
      if (await claimAnchor(dir, { host: endpoint.host, port: endpoint.port, username: endpoint.username, remotePath: path, createdAt: new Date().toISOString() })) return dir;
    }
  }
  throw new RemoteError('Another folder already uses this workspace name. Remove it or choose a different directory.', 409);
}

/** A remote workspace another DSH added on a shared host, with the local folder DSH adopts for it. */
export interface OfferedWorkspace { hostId: string; host: string; remotePath: string; path: string; by?: string }
/** Remote directories adopted as DSH workspaces, anchored by dsh-remote-compatible local folders. */
export class RemoteWorkspaces {
  /** Offers handed to a client recently; another client open at the same time does not add them again. */
  private readonly offered = new Map<string, number>();
  /** Local workspace folders already shared, keyed with the sharing hosts, so each is resolved once. */
  private readonly published = new Set<string>();
  constructor(private readonly service: RemoteAgentsService, private readonly access: WorkspaceAccess, private readonly options: { home?: string; endpoint?: typeof sshEndpoint } = {}) {}
  /** Workspaces other DSH instances added on shared hosts, not yet offered here. Their anchors are created. */
  async shared(signal?: AbortSignal): Promise<OfferedWorkspace[]> {
    const hosts = this.service.store.hosts().filter(sharesSessions);
    const lists = await Promise.allSettled(hosts.map(async host => {
      const offers: OfferedWorkspace[] = [];
      for (const workspace of await this.service.sharedWorkspaces(host.id)) {
        const key = `${host.id}\0${workspace.path}`;
        if (Date.now() - (this.offered.get(key) ?? 0) < 120_000) continue;
        signal?.throwIfAborted();
        this.offered.set(key, Date.now());
        // A folder removed from the machine since it was shared is not offered; one that cannot be checked now is offered later.
        const listing = await this.service.browse(host.id, workspace.path, { entries: false }).catch((error: unknown) => error instanceof Error && /Not a readable directory/.test(error.message) ? 'gone' as const : undefined);
        if (listing === 'gone') { await this.service.seeWorkspaces(host.id, [workspace.path]); continue; }
        if (!listing) { this.offered.delete(key); continue; }
        const endpoint = await (this.options.endpoint ?? sshEndpoint)(host.connection, signal);
        const path = await ensureAnchor(this.options.home ?? dshHome(), endpoint, listing.path).catch(() => undefined);
        if (!path) continue;
        offers.push({ hostId: host.id, host: host.label, remotePath: workspace.path, path, ...(workspace.by ? { by: workspace.by } : {}) });
      }
      return offers;
    }));
    return lists.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  }
  /** Share the remote workspaces this DSH already has, such as ones added before sharing existed. */
  async publish(paths: string[], signal?: AbortSignal): Promise<void> {
    // Only this plugin's anchors; resolving other folders would start processes on every round.
    const root = join(this.options.home ?? dshHome(), 'remote-workspaces');
    // Switching sharing on for another host checks every folder again.
    const sharing = this.service.store.hosts().filter(sharesSessions).map(h => h.id).sort().join(',');
    if (!sharing) return;
    for (const path of paths.slice(0, 500)) {
      const key = `${path}\0${sharing}`;
      if (this.published.has(key) || !under(root, path)) continue;
      const placement = await this.access.resolve(path, signal).catch(() => undefined);
      signal?.throwIfAborted();
      if (!placement) continue;
      let done = true;
      for (const hostId of placement.cwd ? placement.hostIds : []) {
        const host = this.service.store.hosts().find(h => h.id === hostId);
        if (!host || !sharesSessions(host) || this.service.store.seenWorkspaces(hostId).includes(placement.cwd!)) continue;
        await this.service.shareWorkspace(hostId, placement.cwd!).catch(() => { done = false; });
      }
      if (done) this.published.add(key);
    }
  }
  /** Canonicalize the directory on the verified host, then create or reuse its anchor. */
  async create(hostId: string, path: string, signal?: AbortSignal): Promise<RemoteWorkspace> {
    const { path: remote } = await this.service.browse(hostId, path, { entries: false });
    signal?.throwIfAborted();
    const host = this.service.store.hosts().find(h => h.id === hostId);
    if (!host) throw new RemoteError('Remote host not found', 404);
    const endpoint = await (this.options.endpoint ?? sshEndpoint)(host.connection, signal);
    const local = await ensureAnchor(this.options.home ?? dshHome(), endpoint, remote);
    // Revalidate the published binding: it must point at this directory and admit this host's models.
    const placement = await this.access.resolve(local, signal);
    if (placement.cwd !== normalizeRemotePath(remote) || !placement.hostIds.includes(hostId)) throw new RemoteError('The workspace could not be matched to this machine', 409);
    // Other DSH instances connected to this machine offer it too.
    void this.service.shareWorkspace(hostId, placement.cwd).catch(() => {});
    return { hostId, path: local, remotePath: remote };
  }
}
