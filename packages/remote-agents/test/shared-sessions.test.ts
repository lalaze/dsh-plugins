import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LocalTransport, relayHarness, transcript, waitFor } from './relay-harness.js';
import { SshBackend } from '../src/backend.js';
import type { SharedSessions } from '../src/shared.js';
import { RemoteWorkspaces } from '../src/remote-workspaces.js';
import { WorkspaceAccess } from '../src/workspace-access.js';
import { Store } from '../src/store.js';

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
  assert.deepEqual((await h.first.service.state(agent.id)).permissions, []);
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
  assert.ok(second.store.seenWorkspaces(second.store.hosts()[0].id).includes(gone), 'the removed folder is not offered again');
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
