import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Backend } from '../src/backend.js';
import type { Agent, Cursor, HostConfig, PermissionAnswer, Provider, Task, TaskInput, TimelineEntry, TimelinePage } from '../src/domain.js';
import { RemoteAgentsService } from '../src/service.js';
import { Store } from '../src/store.js';

export const providers: Provider[] = [{ id: 'codex', label: 'Codex', status: 'ready', models: [{ id: 'remote-model', label: 'Remote model', isDefault: true, thinkingOptions: [{ id: 'high', label: 'High' }] }], modes: [{ id: 'ask', label: 'Ask before commands' }], defaultModeId: 'ask' }, { id: 'claude', label: 'Claude Code', status: 'unavailable', models: [], modes: [] }];
export class FakeRemote {
  serverId = 'remote-box-1';
  creates = 0; sends = 0; stops = 0; closes = 0;
  loseCreate = false; loseSend = false;
  agents = new Map<string, Agent>();
  receipts = new Map<string, Agent>();
  entries = new Map<string, TimelineEntry[]>();
  answers: { id: string; requestId: string; answer: PermissionAnswer }[] = [];
  catalog = structuredClone(providers);
  created?: Task;
  onCreate?: (agent: Agent, task: Task) => void;
  append(id: string, item: TimelineEntry['item']): void {
    const entries = this.entries.get(id) ?? []; const seq = entries.length + 1;
    entries.push({ seqStart: seq, seqEnd: seq, timestamp: new Date().toISOString(), item }); this.entries.set(id, entries);
  }
  backend = (_host: HostConfig): Backend => ({
    connect: async () => this.serverId,
    close: async () => { this.closes++; },
    providers: async () => structuredClone(this.catalog),
    workspaces: async () => [{ id: 'workspace-one', name: 'Remote project', path: '/srv/project' }],
    create: async task => {
      let agent = this.receipts.get(task.id);
      if (!agent) {
        this.creates++; this.created = structuredClone(task);
        agent = { id: `native-${task.id}`, cwd: task.cwd, provider: task.provider, model: task.model, title: task.title, status: 'idle', pendingPermissions: [], nativeSessionId: `thread-${task.id}` };
        this.agents.set(agent.id, agent); this.receipts.set(task.id, agent);
        this.append(agent.id, { type: 'user_message', text: task.prompt, clientMessageId: task.id });
        this.onCreate?.(agent, task);
      }
      if (this.loseCreate) { this.loseCreate = false; throw new Error('Connection lost after creation'); }
      return structuredClone(agent);
    },
    agent: async id => structuredClone(this.agents.get(id) ?? null),
    timeline: async (id, cursor, direction = 'before') => this.page(id, cursor, direction),
    send: async (id, text, messageId) => {
      this.sends++; this.append(id, { type: 'user_message', text, clientMessageId: messageId });
      this.append(id, { type: 'assistant_message', text: 'Follow-up completed.' });
      if (this.loseSend) { this.loseSend = false; throw new Error('Send receipt lost'); }
    },
    stop: async id => { this.stops++; const agent = this.agents.get(id)!; agent.status = 'idle'; agent.activeTurn = null; agent.pendingPermissions = []; },
    respond: async (id, requestId, answer) => {
      this.answers.push({ id, requestId, answer });
      const agent = this.agents.get(id)!; agent.pendingPermissions = agent.pendingPermissions.filter(p => p.id !== requestId);
    },
  });
  page(id: string, cursor?: Cursor, direction: 'before' | 'after' = 'before'): TimelinePage {
    const all = this.entries.get(id) ?? [];
    const entries = all.filter(e => !cursor || (direction === 'after' ? e.seqStart > cursor.seq : e.seqEnd < cursor.seq));
    return { epoch: 'epoch-one', reset: false, staleCursor: false, gap: false, entries, startCursor: entries.length ? { epoch: 'epoch-one', seq: entries[0].seqStart } : null, endCursor: entries.length ? { epoch: 'epoch-one', seq: entries.at(-1)!.seqEnd } : null, hasOlder: false, hasNewer: false };
  }
}
export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-remote-agents-'));
  const path = join(directory, 'state.json'), store = new Store(path); await store.open();
  const remote = new FakeRemote(), service = new RemoteAgentsService(store, remote.backend);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await service.addHost({ label: 'Build server', connection: 'ssh://builder@build-box' });
  const hostId = state.hosts[0].id;
  const request = (extra: Partial<TaskInput> = {}): TaskInput => ({ id: randomUUID(), hostId, cwd: '/srv/project', provider: 'codex', model: 'remote-model', prompt: 'Fix the remote project', modeId: 'ask', ...extra });
  return { directory, path, store, remote, service, hostId, request };
}
