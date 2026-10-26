import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Backend } from '../src/backend.js';
import { enabledProvidersOf, type Agent, type Cursor, type HostConfig, type PermissionAnswer, type Provider, type Task, type TaskInput, type TimelineEntry, type TimelinePage } from '../src/domain.js';
import { RemoteAgentsService } from '../src/service.js';
import { Store } from '../src/store.js';
import { messageTimeline } from '../src/history.js';

export const providers: Provider[] = [{ id: 'codex', label: 'Codex', status: 'ready', models: [{ id: 'remote-model', label: 'Remote model', isDefault: true, thinkingOptions: [{ id: 'high', label: 'High' }] }], modes: [{ id: 'ask', label: 'Ask before commands' }, { id: 'full-access', label: 'Full access' }], defaultModeId: 'ask' }, { id: 'claude', label: 'Claude Code', status: 'unavailable', models: [], modes: [] }];
/** In-memory backend mirroring SshBackend semantics: sends interrupt running turns and are idempotent by message ID. */
export class FakeRemote {
  serverId = 'remote-box-1';
  creates = 0; sends = 0; stops = 0; closes = 0; interrupts = 0; detaches = 0; forgets = 0;
  loseCreate = false; loseSend = false; dropSend = false;
  agents = new Map<string, Agent>();
  receipts = new Map<string, Agent>();
  entries = new Map<string, TimelineEntry[]>();
  answers: { id: string; requestId: string; answer: PermissionAnswer }[] = [];
  catalog = structuredClone(providers);
  home = '/home/builder';
  homeError?: string;
  discoveries = 0;
  store?: Store;
  created?: Task;
  onCreate?: (agent: Agent, task: Task) => void;
  onSend?: (agent: Agent, text: string) => void;
  append(id: string, item: TimelineEntry['item']): void {
    const entries = this.entries.get(id) ?? []; const seq = entries.length + 1;
    entries.push({ seqStart: seq, seqEnd: seq, timestamp: new Date().toISOString(), item }); this.entries.set(id, entries);
  }
  /** Like CliSession: end a running turn, cancel its unfinished tools and record the interruption. */
  interrupt(id: string): void {
    const agent = this.agents.get(id)!, latest = new Map<string, TimelineEntry['item']>();
    for (const entry of this.entries.get(id) ?? []) if (entry.item.type === 'tool_call') latest.set(String(entry.item.callId), entry.item);
    for (const tool of latest.values()) if (tool.status === 'running') this.append(id, { ...tool, status: 'canceled' });
    agent.status = 'idle'; agent.activeTurn = null; agent.pendingPermissions = [];
    this.append(id, { type: 'interrupted' });
  }
  backend = (host: HostConfig): Backend => ({
    connect: async () => this.serverId,
    close: async () => { this.closes++; },
    homeDirectory: async () => { if (this.homeError) throw new Error(this.homeError); return this.home; },
    providers: async () => { this.discoveries++; const enabled = enabledProvidersOf(this.store?.hosts().find(h => h.id === host.id) ?? host); return structuredClone(this.catalog.filter(p => enabled.includes(p.id))); },
    create: async task => {
      let agent = this.receipts.get(task.id);
      if (!agent) {
        this.creates++; this.created = structuredClone(task);
        agent = { id: `native-${task.id}`, cwd: task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'idle', pendingPermissions: [], nativeSessionId: `thread-${task.id}`, resumable: true };
        this.agents.set(agent.id, agent); this.receipts.set(task.id, agent);
        this.append(agent.id, { type: 'user_message', text: task.prompt, clientMessageId: task.id });
        this.onCreate?.(agent, task);
      }
      if (this.loseCreate) { this.loseCreate = false; throw new Error('Connection lost after creation'); }
      return structuredClone(agent);
    },
    recover: async task => {
      const agent = this.receipts.get(task.id);
      if (!agent) throw new Error('No saved native session');
      if (agent.status === 'closed') agent.status = 'idle';
      return structuredClone(agent);
    },
    agent: async id => structuredClone(this.agents.get(id) ?? null),
    timeline: async (id, cursor, direction = 'before') => this.page(id, cursor, direction),
    messageTimeline: async (id, messageId, cursor) => messageTimeline(this.entries.get(id) ?? [], 'epoch-one', messageId, cursor),
    reply: async id => {
      const entries = this.entries.get(id) ?? [], parts: string[] = [];
      for (let i = entries.length - 1; i >= 0 && entries[i].item.type !== 'user_message'; i--) if (entries[i].item.type === 'assistant_message') parts.unshift(String(entries[i].item.text));
      return parts.join('');
    },
    send: async (id, text, messageId) => {
      if (this.entries.get(id)?.some(e => e.item.clientMessageId === messageId)) return;
      this.sends++;
      if (this.dropSend) throw new Error('Send delivery was not confirmed');
      const agent = this.agents.get(id)!;
      if (agent.status === 'running' || agent.activeTurn || agent.pendingPermissions.length) { this.interrupts++; this.interrupt(id); }
      if (agent.status === 'closed') agent.status = 'idle';
      this.append(id, { type: 'user_message', text, clientMessageId: messageId });
      if (this.onSend) this.onSend(agent, text);
      else this.append(id, { type: 'assistant_message', text: 'Follow-up completed.' });
      if (this.loseSend) { this.loseSend = false; throw new Error('Send receipt lost'); }
    },
    stop: async id => {
      const agent = this.agents.get(id)!;
      if (agent.status !== 'running' && !agent.pendingPermissions.length) return;
      this.stops++; this.interrupt(id);
    },
    respond: async (id, requestId, answer) => {
      this.answers.push({ id, requestId, answer });
      const agent = this.agents.get(id)!; agent.pendingPermissions = agent.pendingPermissions.filter(p => p.id !== requestId);
    },
    detach: async task => {
      const agent = this.receipts.get(task.id);
      if (!agent || agent.status === 'closed') return;
      this.detaches++; agent.status = 'closed'; agent.activeTurn = null; agent.pendingPermissions = [];
    },
    forget: async task => {
      this.forgets++;
      const agent = this.receipts.get(task.id);
      if (agent) { this.agents.delete(agent.id); this.entries.delete(agent.id); this.receipts.delete(task.id); }
    },
  });
  page(id: string, cursor?: Cursor, direction: 'before' | 'after' = 'before'): TimelinePage {
    const all = this.entries.get(id) ?? [];
    const selected = all.filter(e => !cursor || (direction === 'after' ? e.seqStart > cursor.seq : e.seqEnd < cursor.seq));
    const entries = direction === 'after' ? selected.slice(0, 100) : selected.slice(-100);
    return { epoch: 'epoch-one', reset: false, staleCursor: false, gap: false, entries, startCursor: entries.length ? { epoch: 'epoch-one', seq: entries[0].seqStart } : null, endCursor: entries.length ? { epoch: 'epoch-one', seq: entries.at(-1)!.seqEnd } : null, hasOlder: !!entries[0] && entries[0].seqStart > 1, hasNewer: !!entries.length && entries.at(-1)!.seqEnd < all.length };
  }
  /** The native agent behind a service agent ID. */
  live(taskId: string): Agent { return this.receipts.get(taskId)!; }
}
export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-agents-'));
  const path = join(directory, 'state.json'), store = new Store(path); await store.open();
  const remote = new FakeRemote(), service = new RemoteAgentsService(store, remote.backend);
  remote.store = store;
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await service.addHost({ label: 'Build server', connection: 'ssh://builder@build-box' });
  const hostId = state.hosts[0].id;
  const request = (extra: Partial<TaskInput> = {}): TaskInput => ({ id: randomUUID(), hostId, cwd: '/srv/project', provider: 'codex', model: 'remote-model', prompt: 'Fix the remote project', modeId: 'ask', ...extra });
  return { directory, path, store, remote, service, hostId, request };
}
