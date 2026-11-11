import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { relayHarness, transcript, waitFor } from './relay-harness.js';
import type { Message } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { chatModelId, chatProviderId, RemoteCliAdapter, type SyncAgent } from '../src/chat/native-chat.js';
import { ChatProjects } from '../src/chat/projects.js';

const supported = process.platform !== 'win32';
/** Short lease and scan intervals, so takeovers and expiry happen within a test. */
const FAST = { DSH_SHARED_SCAN_MS: '100', DSH_SHARED_LEASE_MS: '2000' };

/** Two DSH instances, each with its own state, connected to the same SSH account. */
async function twoInstances(t: TestContext) {
  const h = await relayHarness(t, FAST);
  await h.first.service.connect(h.hostId);
  const second = await h.open(undefined, join(h.root, 'state-second'));
  const secondHost = (await second.service.addHost({ label: 'Same machine', connection: 'ssh://builder@localhost' })).hosts[0].id;
  await second.service.connect(secondHost);
  await second.service.resume();
  return { h, second, secondHost };
}
const message = (text: string) => ({ id: `message-${randomUUID()}`, text });
const imported = (service: { snapshot(): Promise<{ agents: { id: string }[] }> }, id: string) => waitFor(async () => (await service.snapshot()).agents.find(a => a.id === id), 'session imported by the other DSH');

test('a session started in one DSH appears in another with its history and live status', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'gate'));
  const imported = await waitFor(async () => (await second.service.snapshot()).agents.find(a => a.id === agent.id), 'session imported by the other DSH');
  assert.equal(imported.cwd, h.cwd);
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'running', 'running status shared by the driving DSH');
  assert.ok((await second.service.summary(agent.id)).controller, 'names the DSH driving it');
  await waitFor(async () => (await transcript(second.service, agent.id)).text.includes('waiting'), 'output so far copied');
  await h.gate();
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle', 'turn end shared');
  await waitFor(async () => (await transcript(second.service, agent.id)).text === 'waiting 🌏 after-gate 你好', 'whole reply copied');
  const types = (await transcript(second.service, agent.id)).types;
  assert.deepEqual(types.filter(type => type === 'user_message' || type === 'turn_end'), ['user_message', 'turn_end']);
  // History stays readable from the copy, also for the one that started it.
  assert.equal((await transcript(h.first.service, agent.id)).text, 'waiting 🌏 after-gate 你好');
});

test('sending from another DSH takes the session over and the first follows without repeating anything', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 3'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'first turn');
  await waitFor(async () => (await second.service.snapshot()).agents.some(a => a.id === agent.id), 'imported');
  await waitFor(async () => (await transcript(second.service, agent.id)).types.includes('turn_end'), 'first turn copied');

  await second.service.send(agent.id, message('stream 4'));
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle' && (await transcript(second.service, agent.id)).text.endsWith('c3🌏 '), 'turn sent from the second DSH');
  await waitFor(async () => (await h.first.service.summary(agent.id)).controller, 'the first DSH sees who drives it now');
  const expected = 'c0🌏 c1🌏 c2🌏 c0🌏 c1🌏 c2🌏 c3🌏 ';
  await waitFor(async () => (await transcript(h.first.service, agent.id)).text === expected, 'the first DSH follows the second DSH’s turn');
  assert.deepEqual((await transcript(h.first.service, agent.id)).types.filter(type => type === 'user_message').length, 2);

  // And back: the first DSH sends again, resuming from the shared history.
  await h.first.service.send(agent.id, message('stream 2'));
  await waitFor(async () => (await transcript(second.service, agent.id)).text === `${expected}c0🌏 c1🌏 `, 'the second DSH follows the first again');
  assert.deepEqual((await h.lines('prompts.log')).map(p => p.text), ['stream 3', 'stream 4', 'stream 2'], 'every prompt reached the CLI once');
  const relays = await readdir(h.relays);
  assert.equal(relays.length, 1, 'one CLI process served both DSH instances');
});

test('a permission requested while one DSH drives the CLI can be answered from another', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'approve'));
  await imported(second.service, agent.id);
  const permission = await waitFor(async () => (await second.service.state(agent.id)).permissions[0], 'request shared');
  assert.equal((await second.service.summary(agent.id)).status, 'attention');
  await second.service.respond(agent.id, permission.id, { behavior: 'allow', selectedActionId: 'accept' });
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle', 'answered turn finished');
  assert.match((await transcript(second.service, agent.id)).text, /decision accept/);
  assert.deepEqual((await h.lines('replies.log')).map(r => r.decision), ['accept']);
  await waitFor(async () => /decision accept/.test((await transcript(h.first.service, agent.id)).text), 'the first DSH sees the answer');
  // Its output and its pending requests reach the first DSH separately.
  await waitFor(async () => (await h.first.service.state(agent.id)).permissions.length === 0, 'the request is gone on the first DSH');
});

test('a CLI whose DSH quits is driven by another once its lease expires, and the first does not take it back', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('claude', 'gate'));
  await imported(second.service, agent.id);
  await waitFor(async () => (await transcript(second.service, agent.id)).text.includes('waiting'), 'first output copied');
  await h.first.service.close();
  await h.gate();
  await waitFor(async () => (await transcript(second.service, agent.id)).text === 'waiting 🌏 after-gate 你好', 'the second DSH reads the rest from the CLI', 20_000);
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle', 'turn end');

  const again = await h.open(); await again.service.resume();
  await waitFor(async () => (await transcript(again.service, agent.id)).text === 'waiting 🌏 after-gate 你好', 'the restarted DSH catches up from the shared history');
  await waitFor(async () => (await again.service.summary(agent.id)).controller, 'it leaves the CLI to the DSH driving it');
  assert.equal((await h.lines('prompts.log')).length, 1);
  assert.deepEqual((await transcript(again.service, agent.id)).types.filter(type => type === 'turn_end').length, 1);
});

test('renaming and archiving are shared, and deleting removes the session everywhere', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await waitFor(async () => (await second.service.snapshot()).agents.some(a => a.id === agent.id), 'imported');
  await second.service.rename(agent.id, 'Renamed elsewhere');
  await waitFor(async () => (await h.first.service.summary(agent.id)).title === 'Renamed elsewhere', 'title shared');
  await h.first.service.archive(agent.id);
  await waitFor(async () => (await second.service.summary(agent.id)).archived, 'archive shared');
  await second.service.delete(agent.id);
  await waitFor(async () => !h.first.store.task(task => task.id === agent.id), 'deleted for the first DSH too');
  assert.equal(existsSync(join(h.root, 'state', 'events', `${agent.id}.jsonl`)), false);
  // A deleted session is not imported again.
  const third = await h.open(undefined, join(h.root, 'state-third'));
  const hostId = (await third.service.addHost({ label: 'Third', connection: 'ssh://builder@localhost' })).hosts[0].id;
  await third.service.connect(hostId);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await third.service.snapshot()).agents.length, 0);
});

test('sessions recorded before sharing are published with their history', { skip: !supported }, async t => {
  const h = await relayHarness(t, FAST);
  // Started with sharing off, as before this version.
  await h.first.service.setHostSharing(h.hostId, false);
  const agent = await h.first.service.create(h.request('codex', 'stream 2'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  assert.equal(existsSync(join(h.home, '.dsh-remote-agents', 'shared-v1', 'sessions', agent.id)), false, 'nothing is shared while switched off');
  await h.first.service.setHostSharing(h.hostId, true);
  const second = await h.open(undefined, join(h.root, 'state-second'));
  const hostId = (await second.service.addHost({ label: 'Same machine', connection: 'ssh://builder@localhost' })).hosts[0].id;
  await second.service.connect(hostId);
  await waitFor(async () => (await transcript(second.service, agent.id).catch(() => ({ text: '' }))).text === 'c0🌏 c1🌏 ', 'earlier session published');
  const length = (await transcript(h.first.service, agent.id)).entries.length;
  await waitFor(async () => JSON.parse(await readFile(join(h.home, '.dsh-remote-agents', 'shared-v1', 'sessions', agent.id, 'head.json'), 'utf8').catch(() => '{}')).seq === length, 'whole history published');
  assert.deepEqual((await transcript(second.service, agent.id)).entries, (await transcript(h.first.service, agent.id)).entries);
});

test('with sharing switched off, a DSH neither imports nor publishes sessions', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  await second.service.setHostSharing(secondHost, false);
  assert.equal((await second.service.snapshot()).hosts[0].share, false);
  const agent = await h.first.service.create(h.request('codex', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal((await second.service.snapshot()).agents.length, 0);
  const own = await second.service.create({ ...h.request('codex', 'stream 1'), hostId: secondHost });
  await waitFor(async () => (await second.service.summary(own.id)).status === 'idle', 'local turn');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal((await h.first.service.snapshot()).agents.some(a => a.id === own.id), false);
});

test('remote workspaces added in one DSH are offered to the others once', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  await h.first.service.shareWorkspace(h.hostId, '/srv/app');
  assert.deepEqual(await h.first.service.sharedWorkspaces(h.hostId), [], 'not offered back to the DSH that added it');
  const offered = await waitFor(async () => (await second.service.sharedWorkspaces(secondHost)).find(w => w.path === '/srv/app'), 'offered to the other DSH');
  assert.ok(offered.by);
  await second.service.seeWorkspaces(secondHost, ['/srv/app']);
  assert.deepEqual(await second.service.sharedWorkspaces(secondHost), [], 'not offered again, even if removed from the sidebar');
});

test('a workspace\'s tags set in one DSH reach the others, the latest change wins, and adding workspaces keeps them', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  // Workspace Tags sync compares as soon as the registry reports a change, rather than at its next round.
  await waitFor(async () => await second.service.sharedWorkspaceList(secondHost), 'the other DSH reads the registry');
  const reported: string[] = [], listener = (hostId: string) => { reported.push(hostId); };
  second.service.sharedWorkspaceListeners.add(listener); t.after(() => { second.service.sharedWorkspaceListeners.delete(listener); });
  const set = await h.first.service.setWorkspaceTags(h.hostId, '/srv/app', [{ name: ' Dana ', color: 'lime' }, { name: '', color: 'red' }]);
  assert.deepEqual(set.tags, [{ name: 'Dana', color: 'lime' }]); assert.ok(set.tagsAt); assert.ok(set.tagsBy);
  await waitFor(() => reported.includes(secondHost) || undefined, 'the other DSH is told its shared workspaces changed');
  const seen = await waitFor(async () => (await second.service.sharedWorkspaceList(secondHost))?.find(w => w.path === '/srv/app' && w.tags?.length), 'tags reach the other DSH');
  assert.deepEqual(seen.tags, [{ name: 'Dana', color: 'lime' }]);
  const cleared = await second.service.setWorkspaceTags(secondHost, '/srv/app', []);
  assert.ok(Date.parse(cleared.tagsAt!) >= Date.parse(set.tagsAt!), 'stamped by the host');
  await waitFor(async () => (await h.first.service.sharedWorkspaceList(h.hostId))?.find(w => w.path === '/srv/app')?.tags?.length === 0, 'cleared everywhere');
  await second.service.setWorkspaceTags(secondHost, '/srv/app', [{ name: 'Work', color: 'blue' }]);
  await h.first.service.shareWorkspace(h.hostId, '/srv/other');
  const list = await waitFor(async () => { const all = await h.first.service.sharedWorkspaceList(h.hostId); return all?.some(w => w.path === '/srv/other') ? all : undefined; }, 'workspace added');
  assert.deepEqual(list.find(w => w.path === '/srv/app')?.tags, [{ name: 'Work', color: 'blue' }], 'adding another workspace keeps existing tags');
});

test('after a network outage, the DSH that drove a session does not take it back from the one that took over', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 2'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'first turn');
  await imported(second.service, agent.id);
  // The first DSH loses its network: its relay attachment and registry connection drop.
  h.first.transport.offline = true;
  for (const [child, command] of h.first.transport.processes) if (command.includes(' attach ') || command.includes(' serve ')) child.kill('SIGKILL');
  await second.service.send(agent.id, message('gate'));
  await waitFor(async () => (await transcript(second.service, agent.id)).text.endsWith('waiting 🌏 '), 'the second DSH drives the next turn');
  h.first.transport.offline = false;
  await waitFor(async () => (await h.first.service.summary(agent.id)).controller, 'the first DSH learns who drives it now', 20_000);
  await h.gate();
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle', 'the second DSH finishes the turn it drives');
  assert.equal((await second.service.summary(agent.id)).error, undefined, 'the second DSH was never displaced');
  await waitFor(async () => (await transcript(h.first.service, agent.id)).text === 'c0🌏 c1🌏 waiting 🌏 after-gate 你好', 'the first DSH follows');
  assert.equal((await h.lines('prompts.log')).length, 2);
});

test('a session bound to a main chat in one DSH is an ordinary session in another, which can continue it', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 1'), { chat: { sessionId: 'main-chat-1', route: 'project/codex/fake-model' } });
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  assert.equal((await h.first.service.summary(agent.id)).chatSessionId, 'main-chat-1');
  await imported(second.service, agent.id);
  const copy = await second.service.summary(agent.id);
  assert.equal(copy.chatSessionId, undefined, 'the conversation belongs to the first DSH');
  assert.ok(copy.creator, 'names the DSH that started it');
  await second.service.send(agent.id, message('stream 2'));
  await waitFor(async () => (await transcript(h.first.service, agent.id)).text === 'c0🌏 c0🌏 c1🌏 ', 'the first DSH sees the follow-up');
  assert.equal(h.first.store.task(task => task.id === agent.id)?.chat?.sessionId, 'main-chat-1', 'its main chat binding is kept');
});

test('a message names the DSH that sent it, and the DSH following the session is told when its copy changed', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  const changed: string[] = [];
  h.first.service.sharedHistoryListeners.add(id => changed.push(id));
  const agent = await h.first.service.create(h.request('codex', 'stream 1'), { chat: { sessionId: 'main-chat-1', route: 'project/codex/fake-model' } });
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await imported(second.service, agent.id);
  assert.equal(changed.length, 0, 'nothing to follow while this DSH drives it');
  await second.service.send(agent.id, message('stream 2'));
  await waitFor(async () => changed.includes(agent.id), 'the first DSH is told it copied the other DSH\'s turn');
  await waitFor(async () => (await transcript(h.first.service, agent.id)).text === 'c0🌏 c0🌏 c1🌏 ', 'the turn copied');
  const sender = await second.store.instance();
  const [first, next] = (await transcript(h.first.service, agent.id)).entries.filter(e => e.item.type === 'user_message').map(e => e.item.sentBy);
  assert.equal(first, undefined, 'the first prompt is the one the session started with');
  assert.deepEqual(next, { instance: sender.id, label: sender.label });
  // Both DSH instances run on this computer under the same name: the other one is told apart by its ID.
  assert.deepEqual(h.first.service.sender(h.hostId, sender.id, sender.label), { name: `${sender.label} · ${sender.id.replace(/^dsh-/, '').slice(0, 4)}` });
  assert.deepEqual(second.service.sender(secondHost, sender.id, sender.label), { self: true });
});

test('a conversation is told when another DSH runs a turn in it, even with its history closed; other sessions are not', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 1')), other = await h.first.service.create(h.request('codex', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle' && (await h.first.service.summary(other.id)).status === 'idle', 'first turns');
  await imported(second.service, agent.id); await imported(second.service, other.id);
  await second.store.update(state => { state.tasks.find(task => task.id === agent.id)!.chat = { sessionId: 'main-chat-2', route: 'project/codex/fake-model' }; });
  const changed: string[] = [];
  second.service.sharedHistoryListeners.add(id => changed.push(id));
  await h.first.service.send(agent.id, message('gate')); await h.first.service.send(other.id, message('gate'));
  await waitFor(() => changed.includes(agent.id), 'the conversation is told while the turn runs');
  assert.equal((await second.service.summary(agent.id)).status, 'running');
  assert.equal(existsSync(join(h.root, 'state-second', 'events', `${other.id}.jsonl`)), false, 'a session without a conversation is still copied only when read');
  assert.equal(changed.includes(other.id), false);
  await h.gate();
});

test('a conversation showing another DSH\'s turn shows it to the end when that DSH quits and this one takes the CLI over', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  await second.service.discoverHost(secondHost);
  const agent = await h.first.service.create(h.request('claude', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'first turn');
  await imported(second.service, agent.id);
  // The history reaches this DSH when it is read, in the background.
  const shownAlready = (await waitFor(async () => (await transcript(second.service, agent.id)).entries.find(e => e.item.type === 'user_message'), 'the shared history')).item.clientMessageId as string;
  const route = chatModelId(secondHost, 'claude', 'fake-model'), provider = chatProviderId('claude'), sessionId = SessionId('main-chat-2');
  await second.store.update(state => { state.tasks.find(task => task.id === agent.id)!.chat = { sessionId, route, delivered: { messageId: shownAlready, cursor: null, done: true } }; });
  const adapter = new RemoteCliAdapter(new ChatProjects(second.service), { agent: () => ({ id: 'dsh-agent' }), step: () => undefined, cwd: () => h.cwd,
    workspace: async cwd => ({ hostIds: [secondHost], cwd }), approval: { request: async () => 'allowed-once' }, userQuestions: { ask: async () => ({ answers: [] }) } }, 10);
  t.after(() => adapter.close());
  const sent: Message[] = [];
  const conversation: SyncAgent = { session: { id: sessionId, requestHeader: () => ({ config: { provider, model: route } }) as never }, send: notice => { sent.push(notice); } };

  await h.first.service.send(agent.id, message('gate'));
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'running' && (await transcript(second.service, agent.id)).text.includes('waiting'), 'the turn running on the first DSH');
  assert.equal(await adapter.catchUp(conversation), true);
  const stream = adapter.stream({ provider, model: route, sessionId, messages: sent });
  let shown = '';
  while (!shown.includes('waiting')) { const { value, done } = await stream.next(); assert.ok(!done, 'the reply goes on'); if (value.type === 'text-delta') shown += value.text; }

  await h.first.service.close();
  await h.gate();
  for await (const chunk of stream) if (chunk.type === 'text-delta') shown += chunk.text;
  assert.match(shown, /after-gate 你好$/, 'the rest comes from the CLI after the second DSH takes it over');
  assert.equal(shown.match(/waiting/g)?.length, 1, 'output already shown is not repeated');
  assert.equal(second.store.task(task => task.id === agent.id)?.chat?.delivered?.done, true);
  assert.equal((await second.service.summary(agent.id)).controller, undefined, 'the second DSH drives it now');
});
