// The second half of the shared-session tests: histories, registries, removal and read state. Split from
// shared-sessions.test.ts, which alone ran close to the time one test file may take.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LocalTransport, relayHarness, transcript, waitFor } from './relay-harness.js';
import { SshBackend } from '../src/agents/backend.js';
import type { SharedSessions } from '../src/agents/shared-sessions.js';
import { RemoteWorkspaces } from '../src/workspace/remote-workspaces.js';
import { WorkspaceAccess } from '@dsh-plugins/remote-core/access.js';
import { Store } from '../src/core/store.js';

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

const sessionsDir = (home: string) => join(home, '.dsh-remote-agents', 'shared-v1', 'sessions');
/** Replace a file the way the registry does, so watchers notice. */
async function replace(file: string, value: unknown) { await writeFile(`${file}.tmp`, JSON.stringify(value)); await rename(`${file}.tmp`, file); }

test('another DSH copies a session’s history only when it is read', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 2'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await imported(second.service, agent.id);
  await new Promise(resolve => setTimeout(resolve, 600));
  const events = join(h.root, 'state-second', 'events', `${agent.id}.jsonl`);
  assert.equal(existsSync(events), false, 'listing sessions does not download their histories');
  assert.equal((await transcript(second.service, agent.id)).text, 'c0🌏 c1🌏 ');
  assert.equal(existsSync(events), true);
});

test('a damaged shared record is never taken into the local state', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await imported(second.service, agent.id);
  const file = join(sessionsDir(h.home), agent.id, 'manifest.json'), manifest = JSON.parse(await readFile(file, 'utf8'));
  // As another version or a hand edit might leave it.
  await replace(file, { ...manifest, rev: manifest.rev + 1, title: 42, createdAt: null, relay: { id: '../escape' }, native: 'broken', archived: 'yes', modes: [{}] });
  const incomplete = join(sessionsDir(h.home), `task-${randomUUID()}`);
  await mkdir(incomplete, { recursive: true });
  await replace(join(incomplete, 'manifest.json'), { rev: 1, serverId: manifest.serverId, title: 'No CLI session', agentId: 'agent-12345678' });
  await waitFor(() => second.store.task(task => task.id === agent.id)?.shared?.rev === manifest.rev + 1, 'damaged record seen');
  const copy = second.store.task(task => task.id === agent.id)!;
  assert.equal(copy.title, manifest.title);
  assert.deepEqual(copy.native, manifest.native);
  assert.deepEqual(copy.relay, manifest.relay);
  assert.equal(second.store.snapshot().tasks.length, 1, 'an incomplete record is not imported');
  await second.service.close();
  const reopened = new Store(join(h.root, 'state-second', 'state.json'));
  await reopened.open();
  assert.equal(reopened.snapshot().tasks.length, 1, 'the saved state still loads');
});

test('history a DSH recorded but never shared is replaced by the shared one after another DSH took over', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 2'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await imported(second.service, agent.id);
  await waitFor(async () => (await transcript(second.service, agent.id)).types.includes('turn_end'), 'shared');
  await h.first.service.close();
  // The first DSH recorded more before quitting and never copied it.
  const events = join(h.root, 'state', 'events', `${agent.id}.jsonl`);
  const last = JSON.parse((await readFile(events, 'utf8')).trim().split('\n').at(-1)!).seqStart as number;
  await appendFile(events, [1, 2].map(i => `${JSON.stringify({ seqStart: last + i, seqEnd: last + i, timestamp: new Date().toISOString(), item: { type: 'assistant_message', text: ` unshared ${i}` } })}\n`).join(''));
  await second.service.send(agent.id, message('stream 1'));
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle' && (await transcript(second.service, agent.id)).text === 'c0🌏 c1🌏 c0🌏 ', 'turn driven by the second DSH');
  const again = await h.open(); await again.service.resume();
  await waitFor(async () => JSON.stringify((await transcript(again.service, agent.id)).entries) === JSON.stringify((await transcript(second.service, agent.id)).entries), 'the first DSH holds the shared history');
  assert.doesNotMatch((await transcript(again.service, agent.id)).text, /unshared/);
});

test('switching sharing off withdraws the sessions started here from the other DSH instances and keeps them here', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  const own = await h.first.service.create(h.request('codex', 'stream 1'));
  const theirs = await second.service.create({ ...h.request('codex', 'stream 1'), hostId: secondHost });
  await imported(second.service, own.id); await imported(h.first.service, theirs.id);
  await waitFor(async () => (await h.first.service.summary(own.id)).status === 'idle' && (await second.service.summary(theirs.id)).status === 'idle', 'turns');
  await h.first.service.setHostSharing(h.hostId, false);
  await waitFor(() => !second.store.task(task => task.id === own.id), 'withdrawn from the other DSH');
  assert.equal(h.first.store.task(task => task.id === theirs.id), undefined, 'the other DSH’s session is forgotten here');
  assert.ok(second.store.task(task => task.id === theirs.id), 'and kept there');
  await h.first.service.send(own.id, message('stream 2'));
  await waitFor(async () => (await transcript(h.first.service, own.id)).text === 'c0🌏 c0🌏 c1🌏 ', 'the withdrawn session still works here');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(second.store.task(task => task.id === own.id), undefined, 'and is not shared again');
  // Switched on again, the session is shared again rather than read as deleted.
  await h.first.service.setHostSharing(h.hostId, true);
  await imported(second.service, own.id);
  await waitFor(async () => (await transcript(second.service, own.id)).text === 'c0🌏 c0🌏 c1🌏 ', 'its whole history is shared again');
  assert.equal((await transcript(h.first.service, own.id)).text, 'c0🌏 c0🌏 c1🌏 ', 'and kept here');
  await imported(h.first.service, theirs.id);
});

test('removing a shared machine forgets it here only, unless its sessions are deleted everywhere', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await imported(second.service, agent.id);
  await second.service.removeHost(secondHost, { deleteAgents: true });
  assert.equal(second.store.snapshot().tasks.length, 0);
  assert.equal(second.store.snapshot().hosts.length, 0);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok(h.first.store.task(task => task.id === agent.id), 'the session stays for the other DSH');
  assert.equal((await readdir(h.relays)).length, 1, 'and its CLI keeps running');

  const third = await h.open(undefined, join(h.root, 'state-third'));
  const thirdHost = (await third.service.addHost({ label: 'Third', connection: 'ssh://builder@localhost' })).hosts[0].id;
  await third.service.connect(thirdHost);
  await imported(third.service, agent.id);
  await h.first.service.removeHost(h.hostId, { deleteAgents: true, everywhere: true });
  await waitFor(() => !third.store.task(task => task.id === agent.id), 'deleted for every DSH');
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'CLI stopped');
});

test('a registry with many sessions is listed in pages, and long first prompts are shared in part', { skip: !supported }, async t => {
  const h = await relayHarness(t, FAST);
  await h.first.service.connect(h.hostId);
  const serverId = h.first.store.hosts()[0].serverId!, now = new Date().toISOString();
  for (let i = 0; i < 250; i++) {
    const id = `task-${String(i).padStart(4, '0')}-${randomUUID().slice(0, 8)}`, dir = join(sessionsDir(h.home), id);
    await mkdir(dir, { recursive: true });
    await replace(join(dir, 'manifest.json'), { rev: 1, cwd: h.cwd, provider: 'codex', model: 'fake-model', prompt: i ? `Task ${i}` : 'x'.repeat(5000), serverId, title: `Task ${i}`, createdAt: now, updatedAt: now,
      agentId: id, state: 'ready', native: { protocol: 'codex', sessionId: `thread-${i}`, argv: ['codex', 'app-server'], resumable: true, initialSent: true }, creator: { instance: 'dsh-elsewhere', label: 'elsewhere' } });
  }
  const second = await h.open(undefined, join(h.root, 'state-second'));
  const hostId = (await second.service.addHost({ label: 'Same machine', connection: 'ssh://builder@localhost' })).hosts[0].id;
  await second.service.connect(hostId);
  await waitFor(async () => (await second.service.snapshot()).agents.length === 250, 'every page imported');
  assert.ok(second.store.snapshot().tasks.every(task => task.shared?.creator === 'elsewhere'));

  const long = 'Refactor the build. '.repeat(300).trim();
  const agent = await h.first.service.create({ ...h.request('codex', 'stream 1'), prompt: long });
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  const shared = await waitFor(async () => JSON.parse(await readFile(join(sessionsDir(h.home), agent.id, 'manifest.json'), 'utf8').catch(() => '{}')).prompt as string | undefined, 'published');
  assert.equal(shared.length, 2000);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(h.first.store.task(task => task.id === agent.id)?.prompt, long, 'the DSH that started it keeps the whole prompt');
});

test('taking control of a session the host has no record of keeps its history', { skip: !supported }, async t => {
  const h = await relayHarness(t, FAST);
  await h.first.service.setHostSharing(h.hostId, false);
  const agent = await h.first.service.create(h.request('codex', 'stream 3'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  const before = (await transcript(h.first.service, agent.id)).entries;
  await h.first.service.close();
  const next = await h.open();
  await next.store.update(state => { delete state.hosts[0].share; });
  const backend = new SshBackend(next.store.hosts()[0], next.store, new LocalTransport(h.home, FAST));
  t.after(() => backend.close());
  const shared = (backend as unknown as { shared: SharedSessions }).shared;
  // Act before this session is published, as an action right after switching sharing on can.
  (shared as unknown as { backfill(): Promise<void> }).backfill = async () => {};
  assert.equal((await shared.acquire(agent.id, true)).status, 'claimed');
  assert.deepEqual((await backend.timeline(agent.id)).entries, before);
  await waitFor(async () => JSON.parse(await readFile(join(sessionsDir(h.home), agent.id, 'head.json'), 'utf8').catch(() => '{}')).seq === before.length, 'its history is copied to the host');
});

test('a shared workspace is offered with its local folder, and one removed from the machine is not', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const gone = join(h.home, 'removed-project');
  await mkdir(gone);
  await h.first.service.shareWorkspace(h.hostId, h.cwd);
  await h.first.service.shareWorkspace(h.hostId, gone);
  await rm(gone, { recursive: true });
  const home = join(h.root, 'dsh-home-second'), endpoint = async () => ({ host: 'localhost', username: 'builder', port: 22 });
  const workspaces = new RemoteWorkspaces(second.service, new WorkspaceAccess(() => second.store.hosts(), { home, omc: join(home, 'omc'), endpoint }), { home, endpoint });
  const offered = await waitFor(async () => { const list = await workspaces.shared(); return list.length ? list : undefined; }, 'offer');
  assert.deepEqual(offered.map(w => w.remotePath), [h.cwd]);
  assert.ok(existsSync(join(offered[0].path, '.dsh-remote-meta.json')), 'its local folder is ready for DSH to add');
  assert.deepEqual(await workspaces.shared(), [], 'another client asking right away is not offered it again');
  // The two workspaces can reach this DSH in separate reports of the registry, so the removed one may take another look.
  await waitFor(async () => { await workspaces.shared(); return second.store.seenWorkspaces(second.store.hosts()[0].id).includes(gone); }, 'the removed folder is not offered again');
});

test('deleting a shared machine’s sessions everywhere needs the machine; removing it here only does not', { skip: !supported }, async t => {
  const { h, second, secondHost } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 1'));
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn');
  await imported(second.service, agent.id);
  second.transport.offline = true;
  for (const [child, command] of second.transport.processes) if (command.includes(' serve ') || command.includes(' attach ')) child.kill('SIGKILL');
  await assert.rejects(second.service.removeHost(secondHost, { deleteAgents: true, everywhere: true }), /Connect to this machine/);
  assert.ok(second.store.task(task => task.id === agent.id), 'nothing was deleted');
  await second.service.removeHost(secondHost, { deleteAgents: true });
  assert.equal(second.store.snapshot().hosts.length, 0);
  assert.ok(h.first.store.task(task => task.id === agent.id));
});

test('a session read in one DSH reads as read in another until a new turn, and a read never moves back', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const chat = 'conversation-read-here', other = 'conversation-read-there';
  const agent = await h.first.service.create(h.request('codex', 'stream 2'), { chat: { sessionId: chat, route: 'route' } });
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'turn finished');
  await waitFor(async () => (await second.service.snapshot()).agents.some(a => a.id === agent.id), 'imported');
  await second.store.update(state => { state.tasks.find(task => task.id === agent.id)!.chat = { sessionId: other, route: 'route' }; });

  const told: string[] = [];
  second.service.chatReadListeners.add(id => told.push(id));
  assert.equal(second.service.chatReadMark(other), undefined, 'nobody has read it');
  assert.equal(h.first.service.chatReadMark(chat), undefined);
  assert.equal(second.service.chatReadMark('some-other-conversation'), undefined);

  await h.first.service.markChatRead(chat);
  const mark = h.first.service.chatReadMark(chat);
  assert.ok(mark, 'read here at once');
  await waitFor(() => second.service.chatReadMark(other) === mark, 'read on the other DSH');
  assert.deepEqual(told, [other], 'the other DSH hears of it, under its own conversation');

  // Reading again without anything new asks the host for nothing and keeps the mark.
  await h.first.service.markChatRead(chat);
  assert.equal(h.first.service.chatReadMark(chat), mark);

  await h.first.service.send(agent.id, message('stream 2'));
  await waitFor(() => h.first.service.chatReadMark(chat) === undefined, 'a new turn is unread here');
  await waitFor(() => second.service.chatReadMark(other) === undefined, 'and on the other DSH');
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'second turn finished');
  await waitFor(async () => (await second.service.summary(agent.id)).status === 'idle', 'followed to its end');

  // Now the other direction: the DSH that does not drive the CLI reads it.
  // The DSH driving the CLI reports the end of the turn before the turn's last entries are on the host. A read reported
  // in between covers less than the turn, and both DSHes go on showing it unread: that gap is open, and the page reports a
  // read only once per turn. So this reads until the turn has settled, which is the case a person usually meets.
  const next = await waitFor(async () => {
    await second.service.markChatRead(other);
    const now = second.service.chatReadMark(other);
    return now && now !== mark && h.first.service.chatReadMark(chat) === now ? now : undefined;
  }, 'a later read has a new mark, and it reaches the DSH driving the CLI');
  assert.equal(second.service.chatReadMark(other), next);
});

test('a read reported for a session with no shared registry does nothing', { skip: !supported }, async t => {
  const h = await relayHarness(t, FAST);
  await h.first.service.connect(h.hostId);
  await h.first.service.markChatRead('no-such-conversation');
  assert.equal(h.first.service.chatReadMark('no-such-conversation'), undefined);
});

test('internal child sessions stay local while manual sessions still publish', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const child = await h.first.service.create(h.request('codex', 'stream 2'), { origin: 'subagent' });
  await waitFor(async () => (await h.first.service.summary(child.id)).status === 'idle', 'child completed');
  const normal = await h.first.service.create(h.request('codex', 'stream 2'));
  await imported(second.service, normal.id);
  assert.equal(existsSync(join(h.home, '.dsh-remote-agents', 'shared-v1', 'sessions', child.id, 'manifest.json')), false);
  assert.equal(second.store.task(task => task.id === child.id), undefined);
  assert.ok((await transcript(h.first.service, child.id)).entries.length);
});

test('explicit internal provenance repairs old imports without deleting history and blocks new imports', { skip: !supported }, async t => {
  const { h, second } = await twoInstances(t);
  const agent = await h.first.service.create(h.request('codex', 'stream 2'));
  await imported(second.service, agent.id);
  await waitFor(async () => (await h.first.service.summary(agent.id)).status === 'idle', 'completed');
  const path = join(sessionsDir(h.home), agent.id, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...manifest, origin: 'subagent', rev: manifest.rev + 1 }));
  await waitFor(async () => second.store.task(task => task.id === agent.id)?.origin === 'subagent', 'provenance repaired');
  assert.ok(second.store.task(task => task.id === agent.id));
  assert.ok((await transcript(h.first.service, agent.id)).entries.length);
  const third = await h.open(undefined, join(h.root, 'state-third'));
  const hostId = (await third.service.addHost({ label: 'Third', connection: 'ssh://builder@localhost' })).hosts[0].id;
  await third.service.connect(hostId);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(third.store.task(task => task.id === agent.id), undefined);
});
