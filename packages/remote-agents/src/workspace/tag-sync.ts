import { randomUUID } from 'node:crypto';
import type { SharedTag, SharedWorkspace } from '../core/domain.js';
import type { Store, TagSyncRecord } from '../core/store.js';

/** dsh-workspace-tags' host service, version 1: tags by id, and each workspace's tag ids. */
export interface WorkspaceTagsService {
  readonly version: number;
  snapshot(): TagState;
  replace(state: TagState): Promise<TagState>;
  subscribe(listener: (state: TagState) => void): () => void;
}
interface TagState { tags: { id: string; name: string; color: string }[]; assignments: Record<string, string[]> }
export interface TagSyncHost {
  tags(): WorkspaceTagsService | undefined;
  /** DSH's workspaces, as its workspace controller lists them. */
  workspaces(): readonly { workspaceId: string; path: string }[];
  /** The sharing hosts and remote directory a workspace folder stands for; none for a local workspace. */
  targets(path: string): Promise<{ hostId: string; remotePath: string }[]>;
  /** The host's shared workspaces with their tags, or undefined while its registry cannot be reached. */
  shared(hostId: string): Promise<SharedWorkspace[] | undefined>;
  publish(hostId: string, remotePath: string, tags: SharedTag[]): Promise<SharedWorkspace>;
  warn?(message: string): void;
}

/** Workspace Tags' palette; a color it does not know would drop the tag. */
const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'amber', 'lime', 'emerald', 'cyan', 'sky', 'indigo', 'violet', 'fuchsia', 'rose'];
/** Workspace Tags compares names ignoring case and spacing; so do the DSH instances sharing them. */
const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');
const nameKey = (name: string) => cleanName(name).normalize('NFC').toLowerCase();
const sameNames = (a: readonly string[], b: readonly string[]) => {
  const left = new Set(a.map(nameKey)), right = new Set(b.map(nameKey));
  return left.size === right.size && [...left].every(name => right.has(name));
};
const names = (tags: readonly SharedTag[]) => tags.map(tag => tag.name);
/** Tags of both sides, those of `first` first; a name both carry counts once. */
const union = (first: readonly SharedTag[], second: readonly SharedTag[]) => [...first, ...second.filter(tag => !first.some(other => nameKey(other.name) === nameKey(tag.name)))];

/**
 * Keeps Workspace Tags alike on every DSH that shares a remote workspace: a workspace is known by its host and remote
 * directory, a tag by its name, as workspace and tag ids differ between DSH instances. A change made here is published
 * to the host's shared registry; a newer one found there is applied here. The first time a workspace is compared, tags
 * on both sides are combined, so a DSH that has none never clears another's.
 */
export class WorkspaceTagSync {
  private timer?: ReturnType<typeof setTimeout>;
  private due = 0;
  private running?: Promise<void>;
  private again = false;
  private closed = false;
  private unsubscribe?: () => void;
  private readonly warned = new Set<string>();
  constructor(private readonly store: Store, private readonly host: TagSyncHost, private readonly options: { every?: number; delay?: number } = {}) {}
  start(): void { this.schedule(this.options.delay ?? 3000); }
  close(): void { this.closed = true; clearTimeout(this.timer); this.unsubscribe?.(); }
  /** Compare soon, as after a change on either side. */
  trigger(): void { this.schedule(300); }
  private schedule(delay: number): void {
    // A change only brings the next round closer; a burst of them must not keep postponing it.
    const due = Date.now() + delay;
    if (this.closed || this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
    this.timer.unref?.();
  }
  /** One comparison of every shared workspace; rounds never overlap. */
  run(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.round(); } while (this.again && !this.closed);
      } catch (error) { this.host.warn?.(`Workspace tags could not be synced: ${error instanceof Error ? error.message : String(error)}`); }
      // Changes on either side trigger a round; this one only catches what no report announced, and retries.
      finally { this.running = undefined; this.schedule(this.options.every ?? 30_000); }
    })();
    return this.running;
  }
  private async round(): Promise<void> {
    const service = this.host.tags();
    // Workspace Tags may load after this plugin, or be missing.
    if (!service || service.version !== 1) return;
    this.unsubscribe ??= service.subscribe(() => this.trigger());
    const lists = new Map<string, SharedWorkspace[] | undefined>();
    for (const workspace of this.host.workspaces()) {
      for (const { hostId, remotePath } of await this.host.targets(workspace.path).catch(() => [])) {
        if (this.closed) return;
        if (!lists.has(hostId)) lists.set(hostId, await this.host.shared(hostId));
        const list = lists.get(hostId);
        if (list) await this.sync(service, workspace.workspaceId, hostId, remotePath, list.find(entry => entry.path === remotePath));
      }
    }
  }
  private async sync(service: WorkspaceTagsService, workspaceId: string, hostId: string, remotePath: string, entry: SharedWorkspace | undefined): Promise<void> {
    const key = `${hostId}\0${remotePath}`, last = this.store.tagSync(key);
    const local = this.local(service.snapshot(), workspaceId);
    const shared = entry?.tagsAt ? (entry.tags ?? []).filter(tag => typeof tag?.name === 'string' && cleanName(tag.name)) : undefined;
    let apply: SharedTag[] | undefined, publish: SharedTag[] | undefined;
    if (!last) {
      if (!shared) publish = local.length ? local : undefined;
      else {
        const combined = union(shared, local);
        if (!sameNames(names(combined), names(local))) apply = combined;
        if (!sameNames(names(combined), names(shared))) publish = combined;
        // Nothing to change: remember the agreement so later edits on either side are told apart.
        if (!apply && !publish) await this.remember(key, { names: names(shared), at: entry!.tagsAt });
      }
    } else if (!sameNames(names(local), last.names) || !shared && local.length) publish = local;
    else if (shared && entry!.tagsAt !== last.at) {
      if (!sameNames(names(shared), names(local))) apply = shared;
      else await this.remember(key, { names: names(shared), at: entry!.tagsAt });
    }
    if (apply) {
      await this.assign(service, workspaceId, apply);
      if (!publish) await this.remember(key, { names: names(apply), at: entry?.tagsAt });
    }
    if (publish) {
      try {
        const saved = await this.host.publish(hostId, remotePath, publish);
        this.warned.delete(key);
        await this.remember(key, { names: names(publish), ...(saved.tagsAt ? { at: saved.tagsAt } : {}) });
      } catch (error) {
        // Tried again next round; said once.
        if (!this.warned.has(key)) this.host.warn?.(`Tags of ${remotePath} could not be shared: ${error instanceof Error ? error.message : String(error)}`);
        this.warned.add(key);
      }
    }
  }
  /** A workspace's tags here, by name and color, in the order they were added. */
  private local(state: TagState, workspaceId: string): SharedTag[] {
    return (state.assignments[workspaceId] ?? []).map(id => state.tags.find(tag => tag.id === id)).filter(tag => !!tag).map(tag => ({ name: tag!.name, color: tag!.color }));
  }
  /** Give the workspace exactly these tags, creating the ones this DSH does not have with the color they came with. */
  private async assign(service: WorkspaceTagsService, workspaceId: string, wanted: readonly SharedTag[]): Promise<void> {
    const current = service.snapshot(), tags = current.tags.map(tag => ({ ...tag })), ids: string[] = [];
    for (const tag of wanted) {
      const name = cleanName(tag.name);
      if (!name || [...name].length > 40) continue;
      let found = tags.find(candidate => nameKey(candidate.name) === nameKey(name));
      if (!found) {
        if (tags.length >= 200) continue;
        found = { id: randomUUID(), name, color: COLORS.includes(tag.color) ? tag.color : 'gray' };
        tags.push(found);
      }
      if (!ids.includes(found.id)) ids.push(found.id);
    }
    const assignments = { ...current.assignments };
    if (ids.length) assignments[workspaceId] = ids; else delete assignments[workspaceId];
    await service.replace({ tags, assignments });
  }
  private remember(key: string, value: TagSyncRecord): Promise<void> {
    return this.store.update(state => { (state.tagSync ??= {})[key] = value; });
  }
}
