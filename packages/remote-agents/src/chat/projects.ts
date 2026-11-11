import { randomUUID } from 'node:crypto';
import { enabledProvidersOf, fastTierOf, field, identifier, record, remotePath, RemoteError, type ChatProject, type Choice } from '@dsh-plugins/remote-core/domain.js';
import type { RemoteAgentsService } from '../agents/service.js';

/** Saved, explicitly discovered catalogs let the native model picker work without opening SSH. */
export class ChatProjects {
  private listeners = new Set<() => void>();
  private effortListeners = new Set<() => void>();
  constructor(readonly service: RemoteAgentsService) {}
  list(): ChatProject[] { return this.service.store.chatProjects(); }
  /** The picker advertises one catalog per host; old project routes remain resolvable for saved chats. */
  hosts(): ChatProject[] { return this.service.store.hosts().flatMap(host => host.catalog ? [{ id: host.id, hostId: host.id, label: host.label, cwd: host.catalog.cwd, providers: host.catalog.providers.filter(p => enabledProvidersOf(host).includes(p.id)) }] : []); }
  routes(): ChatProject[] { return [...this.hosts(), ...this.list()]; }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener); const off = this.service.onCatalogChange(listener);
    return () => { this.listeners.delete(listener); off(); };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  /** Only explicit effort selections change a model's advertised default. */
  onEffortChange(listener: () => void): () => void {
    this.effortListeners.add(listener); return () => { this.effortListeners.delete(listener); };
  }
  /** Validate and remember a successful picker selection without SSH or starting a CLI. */
  async setEffort(provider: string, route: string, effort: string): Promise<void> {
    let changed = false;
    await this.service.store.update(state => {
      const [projectId, nativeProvider, nativeModel, nativeTier, ...extra] = route.split('/');
      let cli: string, model: string, tier: string | undefined;
      try {
        cli = decodeURIComponent(nativeProvider ?? ''); model = decodeURIComponent(nativeModel ?? '');
        tier = nativeTier === undefined ? undefined : decodeURIComponent(nativeTier);
      } catch { throw new RemoteError('Invalid remote CLI model'); }
      const project = this.routes().find(p => p.id === projectId);
      const selected = project?.providers.find(p => p.id === cli && p.status === 'ready')?.models.find(m => m.id === model);
      if (!selected || !cli || !model || extra.length || (tier !== undefined && (!tier || !selected.serviceTiers?.some(t => t.id === tier)))
        || (provider !== 'remote-cli' && provider !== `remote-cli-${cli}`)) throw new RemoteError('This remote model is unavailable');
      if (!selected.thinkingOptions?.some(option => option.id === effort)) throw new RemoteError('This remote model does not support that thinking level.');
      // Compare inside the write queue: High → Low → High must not skip the final selection against stale state.
      if (Object.hasOwn(state.chatEfforts ?? {}, route) && state.chatEfforts![route] === effort) return;
      state.chatEfforts = { ...state.chatEfforts, [route]: effort }; changed = true;
    });
    if (changed) for (const listener of this.effortListeners) listener();
  }
  /** The Fast tier a native chat model route offers; a route saved with a tier names the same model. */
  fastTier(route: string): Choice | undefined {
    const [projectId, cli, model] = route.split('/').map(part => { try { return decodeURIComponent(part); } catch { return ''; } });
    const selected = this.routes().find(p => p.id === projectId)?.providers.find(p => p.id === cli && p.status === 'ready')?.models.find(m => m.id === model);
    return selected && fastTierOf(selected);
  }
  /** Whether a conversation's model offers Fast, and whether the conversation has it on. */
  speed(sessionId: string, route: string): { available: boolean; enabled: boolean } {
    return { available: !!this.fastTier(route), enabled: this.service.store.chatFast(sessionId) };
  }
  /** Turn Fast on or off for a conversation's next turns; a turn already running keeps its speed. */
  async setFast(sessionId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.service.store.update(state => {
      // Compare after earlier writes: a queued enable must not make a later disable look redundant.
      if ((state.chatFast?.includes(sessionId) ?? false) === enabled) return;
      const rest = (state.chatFast ?? []).filter(id => id !== sessionId);
      if (enabled) rest.push(sessionId);
      if (rest.length) state.chatFast = rest; else delete state.chatFast;
    });
    return { enabled };
  }
  async add(input: unknown): Promise<ChatProject[]> {
    const value = record(input), hostId = identifier(value.hostId), cwd = remotePath(value.cwd), label = field(value.label, 'project name', 100);
    const providers = await this.service.providers(hostId, cwd, true);
    if (!providers.some(p => p.status === 'ready' && p.models.length)) throw new RemoteError('No ready CLI found in this remote project', 409);
    await this.service.store.update(state => {
      if (!state.hosts.some(h => h.id === hostId)) throw new RemoteError('Remote host was removed', 409);
      const projects = state.mainChatProjects ??= [];
      if (projects.some(p => p.hostId === hostId && p.cwd === cwd)) throw new RemoteError('This main chat project is already saved', 409);
      if (projects.length >= 32) throw new RemoteError('Up to 32 main chat projects can be saved');
      projects.push({ id: randomUUID(), hostId, cwd, label, providers });
    });
    this.changed(); return this.list();
  }
  async refresh(id: string): Promise<ChatProject[]> {
    if (this.service.hosts().some(host => host.id === id)) { await this.service.discoverHost(id); return this.hosts(); }
    const project = this.list().find(p => p.id === id);
    if (!project) throw new RemoteError('Main chat project not found', 404);
    const providers = await this.service.providers(project.hostId, project.cwd, true);
    await this.service.store.update(state => {
      const saved = state.mainChatProjects?.find(p => p.id === id);
      if (!saved) throw new RemoteError('Main chat project was removed', 409);
      saved.providers = providers;
    });
    this.changed(); return this.list();
  }
  async remove(id: string): Promise<ChatProject[]> {
    await this.service.store.update(state => { state.mainChatProjects = state.mainChatProjects?.filter(p => p.id !== id); });
    this.changed(); return this.list();
  }
}
