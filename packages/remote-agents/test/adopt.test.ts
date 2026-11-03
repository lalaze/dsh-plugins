import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createAssistantMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { adoptedSessionId, SharedChatAdoption, type AdoptionHost } from '../src/chat/adopt.js';
import { ChatProjects } from '../src/chat/projects.js';
import { SYNC_SOURCE, chatModelId, chatProviderId, RemoteCliAdapter, type SyncAgent } from '../src/chat/native-chat.js';
import { transcript } from '../src/chat/transcript.js';
import type { TimelineEntry } from '../src/core/domain.js';
import { fixture } from './fakes.js';

const CODEX_PROVIDER = chatProviderId('codex');
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const collect = async (stream: AsyncIterable<StreamChunk>) => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const text = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
const entry = (seq: number, item: TimelineEntry['item']): TimelineEntry => ({ seqStart: seq, seqEnd: seq, timestamp: '2026-10-30T06:02:00.000Z', item });

async function setup(t: TestContext) {
  const base = await fixture(t), projects = new ChatProjects(base.service);
  await base.service.discoverHost(base.hostId); const [project] = projects.hosts();
  const adapter = new RemoteCliAdapter(projects, { agent: () => ({ id: 'dsh-agent' }), step: () => undefined, cwd: () => '/srv/project',
    workspace: async cwd => ({ hostIds: base.store.hosts().map(h => h.id), cwd }),
    approval: { request: async () => 'allowed-once' }, userQuestions: { ask: async () => ({ answers: [] }) } }, 5);
  t.after(() => adapter.close());
  const route = chatModelId(project.id, 'codex', 'remote-model');
  const options = (prompt: string, sessionId = 'macbook-conversation'): GenerateOptions => ({ provider: CODEX_PROVIDER, model: route, sessionId: SessionId(sessionId), messages: [user(prompt)] });
  // A session the MacBook's DSH started: this DSH has its task and history, but no conversation of its own.
  base.remote.onCreate = agent => {
    base.remote.append(agent.id, { type: 'assistant_message', text: 'Found the bug.' });
    base.remote.append(agent.id, { type: 'tool_call', callId: 'c1', name: 'Bash', status: 'completed' });
  };
  await collect(adapter.stream(options('修复登录问题')));
  await base.store.update(state => {
    const task = state.tasks[0];
    delete task.chat; task.shared = { rev: 1, imported: true, creator: 'MacBook Air' }; task.modeId = 'full-access';
    task.native = { protocol: 'codex', sessionId: `thread-${task.id}`, argv: [], initialSent: true };
  });
  const task = base.store.snapshot().tasks[0];
  const calls: string[] = [], listed = new Map<string, { blank: boolean }>(), woken: string[] = [];
  const host: AdoptionHost = {
    anchor: async (hostId, cwd) => { calls.push(`anchor ${hostId} ${cwd}`); return '/local/anchor'; },
    workspace: async path => { calls.push(`workspace ${path}`); return 'workspace-1'; },
    sessions: async () => listed,
    create: async (workspaceId, sessionId) => { calls.push(`create ${workspaceId} ${sessionId}`); listed.set(sessionId, { blank: true }); return sessionId; },
    select: async (_, selection) => { calls.push(`select ${selection.provider} ${selection.model} ${selection.reasoningEffort ?? '-'} ${selection.permission ?? '-'}`); },
    rename: async (_, title) => { calls.push(`rename ${title}`); },
    wake: sessionId => { woken.push(sessionId); },
  };
  const sessionId = adoptedSessionId((await base.store.instance()).id, task.id);
  return { ...base, projects, adapter, route, options, task, calls, listed, woken, host, sessionId };
}
/** DSH's agent for a conversation that has not made a request yet. */
const blank = (sessionId: string, sent: ReturnType<typeof createUserMessage>[]): SyncAgent => ({ session: { id: SessionId(sessionId), requestHeader: () => undefined }, send: message => { sent.push(message); } });

test('a transcript shows what was asked and answered, in the conversation\'s language, without prompt framing or reasoning', () => {
  const { text: zh, lastMessageId } = transcript([
    entry(1, { type: 'user_message', text: 'Conversation context (already occurred; do not repeat completed actions):\nuser: old\n\nCurrent user request:\n修复登录', clientMessageId: 'm1', attachments: [{}] }),
    entry(2, { type: 'reasoning', text: 'private thoughts' }),
    entry(3, { type: 'assistant_message', text: '先看' }), entry(4, { type: 'assistant_message', text: '代码' }),
    entry(5, { type: 'tool_call', callId: 'c1', name: 'Bash', status: 'running' }), entry(6, { type: 'tool_call', callId: 'c1', name: 'Bash', status: 'completed' }),
    entry(7, { type: 'tool_call', callId: 'c2', name: 'Bash', status: 'completed' }), entry(8, { type: 'tool_call', callId: 'c3', name: 'apply_patch', status: 'completed' }),
    entry(9, { type: 'assistant_message', text: '改好了' }),
    entry(10, { type: 'user_message', text: '再跑测试', clientMessageId: 'm2' }), entry(11, { type: 'error', message: 'boom' }), entry(12, { type: 'interrupted' }),
  ], { cli: 'Claude', creator: 'MacBook Air' });
  assert.equal(lastMessageId, 'm2');
  assert.match(zh, /^\*\*这段 Claude 会话的历史记录\*\*（在 MacBook Air 上开始），共 2 轮/);
  assert.match(zh, /\*\*你\*\* · \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(1 个附件\)\n\n修复登录\n/);
  assert.doesNotMatch(zh, /Conversation context|private thoughts/);
  assert.match(zh, /\*\*Claude\*\*\n\n先看代码\n\n改好了\n\n_工具: Bash ×2 · apply\\_patch_/, 'each tool counts once, however many updates it had');
  assert.match(zh, /_boom · 已中断_$/);

  const turns = Array.from({ length: 30 }, (_, i) => [
    entry(i * 2 + 1, { type: 'user_message', text: `Question ${i}`, clientMessageId: `q${i}` }),
    entry(i * 2 + 2, { type: 'assistant_message', text: `\`\`\`js\n${'x'.repeat(9000)}\n\`\`\`\nAnswer ${i}` }),
  ]).flat();
  const { text: en } = transcript(turns, { cli: 'Codex' });
  assert.match(en, /^\*\*History of this Codex session\*\*, 30 turns\./);
  assert.match(en, /_\d+ earlier turns are not shown\. The full record is in Settings → Remote agents → Open sessions\._/);
  assert.match(en, /Question 29\n[\s\S]*Answer 29$/); assert.doesNotMatch(en, /Question 0\n/);
  assert.ok(en.length < 70_000, 'a long history stays one bounded block');
  assert.equal((en.match(/^\s*```/gm) ?? []).length % 2, 0, 'a reply cut inside a code block reopens it');
});

test('a session another DSH started becomes a conversation here, in its workspace, on its CLI, model and permission', async t => {
  const { projects, store, remote, hostId, route, task, calls, listed, woken, host, sessionId } = await setup(t);
  await store.update(state => {
    state.tasks.push({ ...structuredClone(state.tasks[0]), id: 'delegated', origin: 'dsh' }, { ...structuredClone(state.tasks[0]), id: 'archived', archived: true },
      { ...structuredClone(state.tasks[0]), id: 'local', shared: { rev: 1 } });
  });
  // Its history has not reached this DSH yet, as just after DSH starts: it waits for it.
  const saved = remote.entries.get(task.agentId!)!;
  remote.entries.set(task.agentId!, []);
  await new SharedChatAdoption(projects, host).run();
  assert.equal(calls.length, 0); assert.equal(store.snapshot().tasks[0].chat, undefined);
  remote.entries.set(task.agentId!, saved);

  let offline = true;
  const flaky: AdoptionHost = { ...host, anchor: async (id, cwd, signal) => { if (offline) { calls.push('anchor (offline)'); throw new Error('SSH timed out'); } return host.anchor(id, cwd, signal); } };
  const adoption = new SharedChatAdoption(projects, flaky);
  await adoption.run();
  assert.deepEqual(calls, ['anchor (offline)'], 'an unreachable host is asked once per round');
  offline = false; await adoption.run();
  assert.deepEqual(calls, ['anchor (offline)'], 'a failed session waits before it is tried again');

  calls.length = 0;
  await new SharedChatAdoption(projects, flaky).run();
  assert.deepEqual(calls, [`anchor ${hostId} /srv/project`, 'workspace /local/anchor', `create workspace-1 ${sessionId}`,
    `select ${CODEX_PROVIDER} ${route} ${task.thinkingOptionId ?? '-'} danger-full-access`, 'rename 修复登录问题'], 'delegated, archived and local sessions stay as they are');
  assert.deepEqual(store.snapshot().tasks[0].chat, { sessionId, route, history: 'pending' });
  assert.deepEqual(woken, [sessionId]);
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  // A DSH step that fails, unlike an unreachable host, does not hold back the host's other sessions.
  await store.update(state => { state.tasks.push({ ...structuredClone(state.tasks.find(t => t.id === task.id)!), id: 'second', title: 'Second', chat: undefined }); });
  const second = adoptedSessionId((await store.instance()).id, 'second'), failed: string[] = [];
  await new SharedChatAdoption(projects, { ...host, select: async () => { throw new Error('unknown preset'); }, warn: message => failed.push(message) }).run();
  assert.equal(store.snapshot().tasks.find(t => t.id === 'second')?.chat, undefined);
  assert.deepEqual(failed, ['修复登录问题', 'Second'].map(title => `Could not continue the shared remote conversation "${title}" here: select: unknown preset`), 'each session is tried');
  await store.update(state => { state.tasks = state.tasks.filter(t => t.id !== 'second'); });
  listed.delete(second);

  // DSH quit before the history was shown: the conversation it left blank is reused and woken again.
  calls.length = 0; await new SharedChatAdoption(projects, host).run();
  assert.deepEqual(calls.slice(2), [`create workspace-1 ${sessionId}`, `select ${CODEX_PROVIDER} ${route} ${task.thinkingOptionId ?? '-'} danger-full-access`, 'rename 修复登录问题']);
  assert.deepEqual(woken, [sessionId, sessionId]);
  listed.set(sessionId, { blank: false });
  calls.length = 0; await new SharedChatAdoption(projects, host).run();
  assert.deepEqual(calls, [], 'once its first turn started, DSH wakes it when it opens');
});

test('the conversation opens with the saved history, sends nothing, and continues the same CLI session', async t => {
  const { projects, adapter, remote, store, route, options, task, host, sessionId } = await setup(t);
  await new SharedChatAdoption(projects, host).run();
  const sent: ReturnType<typeof createUserMessage>[] = [];
  assert.equal(adapter.sync(blank(sessionId, sent)), true, 'a conversation without a request header is woken for its history');
  assert.equal(adapter.sync(blank(sessionId, sent)), false, 'woken once');
  assert.equal(adapter.sync(blank('another-conversation', sent)), false);
  const [notice] = sent;
  assert.equal(notice.source?.kind, SYNC_SOURCE);
  // DSH answers the notice with context of its own after it, as on a conversation's first request.
  const injected = [{ ...user('Current runtime context.'), source: { kind: 'runtime-context' } }, { ...user('Time sampled while preparing turn 1'), source: { kind: 'time-context' } }] as unknown as ReturnType<typeof user>[];
  assert.equal((notice.source as { summary?: string }).summary, 'Saved history of this Codex session, started on MacBook Air');

  const { creates, sends } = remote;
  const chunks = await collect(adapter.stream({ ...options('', sessionId), messages: [notice, ...injected] }));
  const history = text(chunks);
  assert.match(history, /^\*\*这段 Codex 会话的历史记录\*\*（在 MacBook Air 上开始），共 1 轮/);
  assert.match(history, /修复登录问题[\s\S]*Found the bug\.[\s\S]*工具: Bash/);
  assert.equal(chunks.at(-1)?.type, 'finish');
  assert.equal(remote.creates, creates); assert.equal(remote.sends, sends, 'showing the history sends nothing');
  const chat = store.snapshot().tasks[0].chat!;
  assert.equal(chat.history, undefined); assert.equal(chat.delivered?.done, true);
  assert.equal(adapter.sync({ session: { id: SessionId(sessionId), requestHeader: () => ({ config: { provider: CODEX_PROVIDER, model: route } }) as never }, send: () => {} }), false, 'nothing is left to show');

  const reply = createAssistantMessage({ source: { provider: CODEX_PROVIDER, model: route }, content: [{ type: 'text', text: history }] });
  const next = options('再跑一遍测试', sessionId);
  assert.equal(text(await collect(adapter.stream({ ...next, messages: [notice, ...injected, reply, ...next.messages, ...injected] }))), 'Follow-up completed.');
  assert.equal(remote.creates, creates, 'the same CLI session continues'); assert.equal(remote.sends, sends + 1);
  const delivered = remote.entries.get(task.agentId!)!.findLast(e => e.item.type === 'user_message')!;
  assert.equal(delivered.item.text, '再跑一遍测试', 'the history it showed is the CLI\'s own output and is not sent back');
});

test('a turn still running where the session started streams on after its history', async t => {
  const { projects, adapter, remote, store, options, task, host, sessionId } = await setup(t);
  await new SharedChatAdoption(projects, host).run();
  const live = remote.live(task.id); live.status = 'running';
  const sent: ReturnType<typeof createUserMessage>[] = [];
  adapter.sync(blank(sessionId, sent));
  setTimeout(() => { remote.append(live.id, { type: 'assistant_message', text: 'Tests pass now.' }); live.status = 'idle'; }, 30);
  const output = text(await collect(adapter.stream({ ...options('', sessionId), messages: sent })));
  assert.match(output, /Found the bug\.[\s\S]*\n\n---\n\nTests pass now\.$/);
  assert.equal(output.match(/Found the bug/g)?.length, 1, 'output already in the history is not repeated');
  assert.equal(store.snapshot().tasks[0].chat?.delivered?.done, true);
});
