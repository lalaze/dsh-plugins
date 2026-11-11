import type { Backend } from './backend.js';
import type { HostConnections } from './host-connections.js';
import type { Store } from '../core/store.js';
import { RemoteError, sharesSessions, type SharedTag, type SharedWorkspace } from '@dsh-plugins/remote-core/domain.js';

/** Sharing needs local backend access, never the verified remote-operation path or the catalog queue. */
type SharedHosts = Pick<HostConnections, 'host' | 'backend' | 'peek' | 'stopped'>;
interface Notifications {
  workspaces(hostId: string): void;
  history(taskId: string): void;
  read(sessionId: string): void;
}

/** Coordinates shared notifications, read positions and workspace discovery for this DSH. */
export class SharedSync {
  constructor(private readonly store: Store, private readonly hosts: SharedHosts, private readonly notify: Notifications) {}
  /** Subscribe as soon as a backend exists; local history reads need notifications before connect. */
  bind(hostId: string, backend: Backend): void {
    backend.onSharedWorkspaces?.(() => this.notify.workspaces(hostId));
    backend.onSharedHistory?.(taskId => this.notify.history(taskId));
    backend.onSharedRead?.(taskId => {
      const sessionId = this.store.task(t => t.id === taskId)?.chat?.sessionId;
      if (sessionId) this.notify.read(sessionId);
    });
  }
  /**
   * What marks a conversation as read as far as its shared histories go, by whichever DSH or phone. It changes with each
   * new read, so a reader can tell a read from one made before a turn it knows of. Nothing while a turn is still unread,
   * or for a conversation with no shared CLI.
   */
  chatReadMark(sessionId: string): string | undefined {
    const marks: string[] = [];
    for (const task of this.store.tasks(t => t.chat?.sessionId === sessionId)) {
      const position = this.hosts.peek(task.hostId)?.readPosition?.(task.id);
      if (!position) continue;
      if (!position.read || position.read < position.head) return undefined;
      marks.push(`${task.id}:${position.read}`);
    }
    return marks.length ? marks.join() : undefined;
  }
  /** The user read a conversation: tell every DSH and phone sharing its CLIs. */
  async markChatRead(sessionId: string): Promise<void> {
    const tasks = this.store.tasks(t => t.chat?.sessionId === sessionId);
    if (this.hosts.stopped) return;
    for (const hostId of new Set(tasks.map(task => task.hostId))) this.hosts.backend(hostId).startSharing?.();
    await Promise.allSettled(tasks.map(task => this.hosts.backend(task.hostId).markRead?.(task.id)));
  }
  /** Remote workspaces other DSH instances added on this host that were not offered to this DSH yet. */
  async sharedWorkspaces(hostId: string): Promise<SharedWorkspace[]> {
    const host = this.hosts.host(hostId);
    if (!sharesSessions(host)) return [];
    const backend = this.hosts.backend(hostId);
    backend.startSharing?.();
    const seen = new Set(this.store.seenWorkspaces(hostId));
    return (await backend.sharedWorkspaces?.() ?? []).filter(w => !seen.has(w.path));
  }
  /** Offered to DSH: not offered again, even when removed from the sidebar. */
  async seeWorkspaces(hostId: string, paths: string[]): Promise<void> {
    this.hosts.host(hostId);
    await this.store.update(state => {
      const seen = new Set(state.seenWorkspaces?.[hostId] ?? []);
      for (const path of paths) seen.add(path);
      (state.seenWorkspaces ??= {})[hostId] = [...seen].slice(-2000);
    });
  }
  /** Every workspace shared on this host, with its tags; undefined while its registry cannot be reached. */
  async sharedWorkspaceList(hostId: string, timeout = 3000): Promise<SharedWorkspace[] | undefined> {
    const host = this.store.hosts().find(h => h.id === hostId);
    if (!host || !sharesSessions(host) || this.hosts.stopped) return undefined;
    const backend = this.hosts.backend(hostId);
    backend.startSharing?.();
    return backend.sharedWorkspaces?.(timeout).catch(() => undefined);
  }
  /** Share a workspace's tags with the other DSH instances on this host. */
  async setWorkspaceTags(hostId: string, path: string, tags: SharedTag[]): Promise<SharedWorkspace> {
    if (!sharesSessions(this.hosts.host(hostId))) throw new RemoteError('Sessions are not shared on this host', 409);
    const backend = this.hosts.backend(hostId);
    if (!backend.setWorkspaceTags) throw new RemoteError('This host cannot share workspace tags', 409);
    return backend.setWorkspaceTags(path, tags);
  }
  /** Record a remote workspace on its host so other DSH instances offer it too. */
  async shareWorkspace(hostId: string, path: string): Promise<void> {
    if (!sharesSessions(this.hosts.host(hostId))) return;
    await this.hosts.backend(hostId).shareWorkspace?.(path);
    // Only once it reached the host; a failed attempt is repeated later.
    await this.seeWorkspaces(hostId, [path]);
  }
  /** Who sent a message a shared history records with its sender: this DSH, or another one by name. */
  sender(hostId: string, instance: string, label: string): { self: true } | { name: string } {
    if (instance === this.store.instanceId()) return { self: true };
    return this.hosts.peek(hostId)?.sender?.(instance, label) ?? { name: label };
  }
}
