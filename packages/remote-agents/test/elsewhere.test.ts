import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createAssistantMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ChatProjects } from '../src/chat/projects.js';
import { SYNC_SOURCE, chatModelId, chatProviderId, RemoteCliAdapter, type SyncAgent } from '../src/chat/native-chat.js';
import { transcript } from '../src/chat/transcript.js';
import type { TimelineEntry } from '../src/core/domain.js';
import { fixture } from './fakes.js';

const CODEX_PROVIDER = chatProviderId('codex');
type Message = GenerateOptions['messages'][number];
const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const collect = async (stream: AsyncIterable<StreamChunk>) => { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const text = (chunks: StreamChunk[]) => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
const entry = (seq: number, item: TimelineEntry['item']): TimelineEntry => ({ seqStart: seq, seqEnd: seq, timestamp: '2026-11-03T10:03:36.000Z', item });
const MAC_MINI = { instance: 'dsh-mac-mini', label: 'Mac mini' };

/** A conversation on this DSH that ran one turn in a CLI session another DSH also drives. */
async function setup(t: TestContext, first = '修复登录问题') {
  const base = await fixture(t), projects = new ChatProjects(base.service);
  await base.service.discoverHost(base.hostId); const [project] = projects.hosts();
  const adapter = new RemoteCliAdapter(projects, { agent: () => ({ id: 'dsh-agent' }), step: () => undefined, cwd: () => '/srv/project',
    workspace: async cwd => ({ hostIds: base.store.hosts().map(h => h.id), cwd }),
    approval: { request: async () => 'allowed-once' }, userQuestions: { ask: async () => ({ answers: [] }) } }, 5);
  t.after(() => adapter.close());
  const route = chatModelId(project.id, 'codex', 'remote-model'), sessionId = 'macbook-conversation';
  base.remote.onCreate = agent => { base.remote.append(agent.id, { type: 'assistant_message', text: '找到问题了。' }); };
  // DSH's messages so far: what was asked here and answered.
  const messages: Message[] = [user(first)];
  messages.push(createAssistantMessage({ source: { provider: CODEX_PROVIDER, model: route }, content: [{ type: 'text', text: text(await collect(adapter.stream(request(messages)))) }] }));
  function request(messages: Message[]): GenerateOptions { return { provider: CODEX_PROVIDER, model: route, sessionId: SessionId(sessionId), messages }; }
  const task = () => base.store.snapshot().tasks[0], agentId = task().agentId!;
  /** A turn another DSH, or Open sessions, ran in the same CLI session. */
  const elsewhere = (id: string, prompt: string, reply: string, sentBy?: { instance: string; label: string }, done = true) => {
    base.remote.append(agentId, { type: 'user_message', text: prompt, clientMessageId: id, ...(sentBy ? { sentBy } : {}) });
    base.remote.append(agentId, { type: 'assistant_message', text: reply });
    base.remote.append(agentId, { type: 'tool_call', callId: `${id}-tool`, name: 'Bash', status: 'completed' });
    if (done) base.remote.append(agentId, { type: 'turn_end', clientMessageId: id, status: 'completed' });
  };
  const sent: ReturnType<typeof createUserMessage>[] = [];
  const agent: SyncAgent = { session: { id: SessionId(sessionId), requestHeader: () => ({ config: { provider: CODEX_PROVIDER, model: route } }) as never }, send: message => { sent.push(message); } };
  /** DSH answering what was sent to its agent, then the conversation as it reads afterwards. */
  const answer = async (message: Message) => {
    const reply = text(await collect(adapter.stream(request([...messages, message]))));
    messages.push(message, createAssistantMessage({ source: { provider: CODEX_PROVIDER, model: route }, content: [{ type: 'text', text: reply }] }));
    return reply;
  };
  return { ...base, adapter, route, task, agentId, elsewhere, agent, sent, answer, messages };
}
const prompts = (entries: TimelineEntry[] | undefined) => (entries ?? []).filter(e => e.item.type === 'user_message').map(e => e.item.text);

test('a turn another DSH ran in the same CLI session shows here once it ends, and nothing is sent to the CLI', async t => {
  const { adapter, remote, task, agentId, elsewhere, agent, sent, answer } = await setup(t);
  const live = remote.live(task().id);
  live.status = 'running';
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI, false);
  assert.equal(await adapter.catchUp(agent), false, 'a turn still running elsewhere waits');
  remote.append(agentId, { type: 'turn_end', clientMessageId: 'phone-1', status: 'completed' }); live.status = 'idle';
  assert.equal(await adapter.catchUp(agent), true);
  assert.equal(await adapter.catchUp(agent), false, 'woken once');
  const [notice] = sent;
  assert.equal(notice.source?.kind, SYNC_SOURCE);
  assert.equal((notice.source as { summary?: string }).summary, 'Codex turn on Mac mini');

  const sends = remote.sends, shown = await answer(notice);
  assert.match(shown, /^\*\*在 Mac mini 上进行的 1 轮\*\*，同一个 Codex 会话。/);
  assert.match(shown, /提交发布[\s\S]*已发布 0\.2\.1。[\s\S]*工具: Bash/);
  assert.doesNotMatch(shown, /修复登录问题|找到问题了/, 'what this conversation already shows is not repeated');
  assert.equal(remote.sends, sends, 'showing it sends nothing');
  assert.deepEqual(task().chat?.delivered, { messageId: 'phone-1', cursor: null, done: true });
  assert.equal(await adapter.catchUp(agent), false, 'nothing is left to show');

  // The next message continues the same CLI session with only what was typed: the CLI ran those turns itself.
  assert.equal(await answer(user('再跑一遍测试')), 'Follow-up completed.');
  assert.deepEqual(prompts(remote.entries.get(agentId)), ['修复登录问题', '提交发布', '再跑一遍测试']);
});

test('a turn without a recorded end waits, even while the DSH running it has not reported it busy yet', async t => {
  const { adapter, remote, agentId, elsewhere, agent } = await setup(t);
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI, false);
  assert.equal(await adapter.catchUp(agent), false);
  // One that never ends, as when its CLI vanished, is shown once it has been quiet for a while.
  for (const saved of remote.entries.get(agentId)!) saved.timestamp = new Date(Date.now() - 61_000).toISOString();
  assert.equal(await adapter.catchUp(agent), true);
});

test('turns that ended are shown even when another one has started since', async t => {
  const { adapter, elsewhere, agent, sent, answer, task } = await setup(t);
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI);
  assert.equal(await adapter.catchUp(agent), true);
  // The phone sends again before this DSH answers the notice.
  elsewhere('phone-2', '再检查一下市场', '正在看…', MAC_MINI, false);
  const shown = await answer(sent[0]);
  assert.match(shown, /^\*\*在 Mac mini 上进行的 1 轮\*\*[\s\S]*已发布 0\.2\.1。/);
  assert.doesNotMatch(shown, /再检查一下市场/, 'the running turn waits');
  assert.equal(task().chat?.delivered?.messageId, 'phone-1');
});

test('turns another DSH ran come first in the reply to the next message sent here', async t => {
  const { remote, agentId, elsewhere, answer, task } = await setup(t);
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI);
  elsewhere('phone-2', '再检查一下市场', '市场上是 0.2.1。', MAC_MINI);
  const reply = await answer(user('好的，继续'));
  assert.match(reply, /^\*\*在 Mac mini 上进行的 2 轮\*\*[\s\S]*提交发布[\s\S]*再检查一下市场[\s\S]*市场上是 0\.2\.1。[\s\S]*\n\n---\n\nFollow-up completed\.$/);
  assert.deepEqual(prompts(remote.entries.get(agentId)), ['修复登录问题', '提交发布', '再检查一下市场', '好的，继续'], 'the turns shown are not sent again');
  assert.equal(task().chat?.delivered?.done, true);
  assert.equal(await answer(user('再来')), 'Follow-up completed.', 'shown once');
});

test('the heading names where the turns ran: another DSH, Open sessions here, or elsewhere when not recorded', async t => {
  const { adapter, store, elsewhere, agent, sent, answer } = await setup(t, 'Fix the login bug');
  const me = await store.instance();
  elsewhere('panel-1', 'Ship it', 'Shipped.', { instance: me.id, label: me.label });
  assert.equal(await adapter.catchUp(agent), true);
  assert.equal((sent.at(-1)!.source as { summary?: string }).summary, 'Codex turn in Open sessions');
  assert.match(await answer(sent.at(-1)!), /^\*\*1 turn in Open sessions\*\*, in the same Codex session\./);

  elsewhere('old-1', 'Check the release', 'Released.');
  elsewhere('phone-1', 'And the market', 'Listed.', MAC_MINI);
  assert.equal(await adapter.catchUp(agent), true);
  assert.equal((sent.at(-1)!.source as { summary?: string }).summary, 'Codex turns sent elsewhere', 'a mix, or a message without its sender');
  assert.match(await answer(sent.at(-1)!), /^\*\*2 turns sent elsewhere\*\*/);
});

test('a cut-off response here and the turns another DSH ran after it are shown together, in order', async t => {
  const { adapter, store, remote, agentId, elsewhere, agent, sent, answer, task } = await setup(t);
  const first = task().chat!.delivered!.messageId;
  // DSH quit while its response was still arriving; the CLI finished it, then the phone sent a message.
  remote.append(agentId, { type: 'assistant_message', text: '修好了。' });
  await store.update(state => { state.tasks[0].chat!.delivered = { messageId: first, cursor: { epoch: 'epoch-one', seq: 2 } }; });
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI);
  assert.equal(await adapter.catchUp(agent), false, 'the cut-off response is sync\'s to show');
  assert.equal(adapter.sync(agent), true);
  assert.match(await answer(sent[0]), /^修好了。\n\n---\n\n\*\*在 Mac mini 上进行的 1 轮\*\*[\s\S]*已发布 0\.2\.1。/);
  assert.deepEqual(task().chat?.delivered, { messageId: 'phone-1', cursor: null, done: true });
});

test('turns are not shown when the turn this conversation showed last is gone from the history', async t => {
  const { adapter, store, elsewhere, agent, answer } = await setup(t);
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI);
  await store.update(state => { state.tasks[0].chat!.delivered = { messageId: 'replaced', cursor: null, done: true }; });
  assert.equal(await adapter.catchUp(agent), false);
  assert.equal(await answer(user('继续')), 'Follow-up completed.');
});

test('a conversation switched to another model is not woken', async t => {
  const { adapter, elsewhere, sent } = await setup(t);
  elsewhere('phone-1', '提交发布', '已发布 0.2.1。', MAC_MINI);
  const other: SyncAgent = { session: { id: SessionId('macbook-conversation'), requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) as never }, send: message => { sent.push(message); } };
  assert.equal(await adapter.catchUp(other), false, 'another model would answer the notice');
  assert.deepEqual(sent, []);
});

test('turns from elsewhere read in the conversation\'s language, with what was asked, answered and used', () => {
  const entries = [
    entry(1, { type: 'user_message', text: 'Ship it', clientMessageId: 'm1', sentBy: MAC_MINI }),
    entry(2, { type: 'assistant_message', text: 'Shipped.' }), entry(3, { type: 'tool_call', callId: 'c1', name: 'Bash', status: 'completed' }),
  ];
  assert.equal(transcript(entries, { cli: 'Claude', elsewhere: { from: { name: 'Mac mini' } } }).text,
    `**1 turn on Mac mini**, in the same Claude session.\n\n---\n\n**You** · ${stamp(entries[0].timestamp)}\n\nShip it\n\n**Claude**\n\nShipped.\n\n_Tools: Bash_`);
  assert.match(transcript(entries, { cli: 'Claude', elsewhere: { from: undefined } }).text, /^\*\*1 turn sent elsewhere\*\*/);
});
function stamp(value: string) {
  const date = new Date(value), two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
