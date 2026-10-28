import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { relayHarness, transcript, waitFor } from './relay-harness.js';
import { RELAY_UNAVAILABLE } from '../src/domain.js';
import { RelayClient } from '../src/relay.js';
import type { SshTransport } from '../src/ssh.js';

/** A relay client on a host that is known to support relays. */
const openRelay = async (transport: SshTransport) => { const client = await RelayClient.open(transport); assert.ok(client instanceof RelayClient, `relay unavailable: ${client}`); return client; };
const PROTOCOLS = [['codex', 'Codex app-server'], ['claude', 'Claude stream-json'], ['dsh', 'ACP']] as const;

for (const [provider, label] of PROTOCOLS) test(`${label}: a task keeps running through a DSH shutdown, completes offline and is recovered once after restart`, async t => {
  const h = await relayHarness(t);
  const { service } = h.first;
  const agent = await service.create(h.request(provider, 'gate'));
  assert.equal(agent.status, 'running'); assert.equal(agent.persistent, true);
  await waitFor(async () => (await transcript(service, agent.id)).text.includes('waiting'), 'first output');
  const [daemon] = await h.relayPids();
  await service.close();
  assert.ok(h.alive(daemon), 'the relay outlives DSH');
  await h.gate();
  await waitFor(async () => (await readdir(h.relays)).some(id => existsSync(join(h.relays, id, 'out.log'))), 'relay output');
  // The CLI finishes while no DSH is attached.
  await new Promise(resolve => setTimeout(resolve, 300));

  const next = await h.open(); await next.service.resume();
  await waitFor(async () => (await next.service.summary(agent.id)).status === 'idle', 'turn completion after restart');
  const after = await transcript(next.service, agent.id);
  assert.equal(after.text, 'waiting 🌏 after-gate 你好', 'offline output recovered exactly once');
  assert.equal(after.types.filter(type => type === 'user_message').length, 1);
  assert.deepEqual(after.entries.filter(e => e.item.type === 'turn_end').map(e => e.item.status), ['completed']);
  assert.equal((await h.lines('prompts.log')).length, 1, 'no prompt was repeated');

  await next.service.send(agent.id, { id: randomUUID(), text: 'stream 3' });
  await waitFor(async () => (await next.service.summary(agent.id)).status === 'idle', 'follow-up');
  assert.match((await transcript(next.service, agent.id)).text, /c0🌏 c1🌏 c2🌏 $/);
  assert.equal((await h.lines('prompts.log')).length, 2);
  assert.deepEqual(await h.lines('unexpected.log'), [], 'the CLI received no duplicate replies');

  await next.service.delete(agent.id);
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'relay removal');
  await waitFor(() => !h.alive(daemon), 'relay daemon exit');
});

test('without a usable Node.js the CLI is not started and the reason is reported', async t => {
  const fake = await mkdtemp(join(tmpdir(), 'dsh-old-node-')); t.after(() => rm(fake, { recursive: true, force: true }));
  await writeFile(join(fake, 'node'), '#!/bin/sh\nexit 1\n'); await chmod(join(fake, 'node'), 0o755);
  const h = await relayHarness(t, { PATH: `${fake}:${process.env.PATH}` });
  const agent = await h.first.service.create(h.request('claude', 'stream 1'));
  assert.equal(agent.started, false); assert.equal(agent.error, RELAY_UNAVAILABLE['old-node']);
  assert.equal(existsSync(h.relays), false, 'no relay was installed');
});

test('repeated SSH interruptions reconnect from the saved byte offset without losing or repeating output', async t => {
  const h = await relayHarness(t);
  const { service, transport } = h.first;
  const agent = await service.create(h.request('codex', 'stream 200'));
  for (let i = 0; i < 5; i++) {
    await waitFor(async () => (await transcript(service, agent.id)).text.split(' ').length > 10 * (i + 1), 'more output');
    assert.equal(transport.drop(), 1);
    await waitFor(async () => (await service.summary(agent.id)).reconnecting, 'a dropped connection is reported, not treated as an exit');
    await waitFor(async () => !(await service.summary(agent.id)).reconnecting, 'reconnected');
  }
  await waitFor(async () => (await service.summary(agent.id)).status === 'idle', 'turn completion', 30_000);
  const expected = Array.from({ length: 200 }, (_, i) => `c${i}🌏 `).join('');
  const { text, entries } = await transcript(service, agent.id);
  assert.equal(text, expected);
  assert.deepEqual(entries.filter(e => e.item.type === 'turn_end').map(e => e.item.status), ['completed']);
  assert.equal((await service.summary(agent.id)).reconnecting, undefined);
  assert.equal((await h.lines('prompts.log')).length, 1);
});

for (const [provider, label] of PROTOCOLS) test(`${label}: a pending approval survives restarts, is answered once, and is never asked again`, async t => {
  const h = await relayHarness(t);
  const agent = await h.first.service.create(h.request(provider, 'approve'));
  await waitFor(async () => (await h.first.service.state(agent.id)).permissions.length === 1, 'permission request');
  await h.first.service.close();

  // Restarted while the host is unreachable: the request is restored from saved history.
  const offline = await h.open(); offline.transport.offline = true; await offline.service.resume();
  const restored = await waitFor(async () => (await offline.service.state(agent.id)).permissions[0], 'restored permission');
  const summary = await offline.service.summary(agent.id);
  assert.equal(summary.status, 'attention'); assert.equal(summary.reconnecting, true);
  const allow = restored.actions?.find(a => a.behavior === 'allow' && a.scope !== 'session');
  await offline.service.respond(agent.id, restored.id, { behavior: 'allow', ...(allow ? { selectedActionId: allow.id } : {}) });
  assert.equal((await offline.service.state(agent.id)).permissions.length, 0, 'an answer given offline is saved and queued');
  await offline.service.close();

  // The next DSH resends the saved answer; the relay delivers it once.
  const next = await h.open(); await next.service.resume();
  await waitFor(async () => (await next.service.summary(agent.id)).status === 'idle', 'turn completion');
  assert.equal((await next.service.state(agent.id)).permissions.length, 0);
  const replies = await h.lines('replies.log');
  assert.equal(replies.length, 1); assert.match(String(replies[0].decision), /accept|allow/);
  assert.match((await transcript(next.service, agent.id)).text, /^asking decision (accept|allow)$/);
  await next.service.close();

  const again = await h.open(); await again.service.resume();
  await waitFor(async () => (await again.service.summary(agent.id)).attached, 'reattach');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await again.service.state(agent.id)).permissions.length, 0, 'an answered request is not asked again');
  assert.equal((await h.lines('replies.log')).length, 1);
  assert.deepEqual(await h.lines('unexpected.log'), []);
});

for (const [provider, label] of PROTOCOLS) test(`${label}: explicit stop interrupts the turn and keeps the relay; archiving terminates it`, async t => {
  const h = await relayHarness(t);
  const { service } = h.first;
  const agent = await service.create(h.request(provider, 'gate'));
  await waitFor(async () => (await transcript(service, agent.id)).text.includes('waiting'), 'first output');
  await service.stop(agent.id);
  const stopped = await transcript(service, agent.id);
  assert.deepEqual(stopped.entries.filter(e => e.item.type === 'turn_end').map(e => e.item.status), ['canceled']);
  assert.equal((await service.summary(agent.id)).status, 'idle');
  assert.equal((await readdir(h.relays)).length, 1, 'stopping a turn keeps the CLI process');
  await service.archive(agent.id);
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'relay removal on archive');
  await waitFor(() => h.first.store.snapshot().relayCleanups === undefined, 'cleanup record removal');
});

test('deleting an agent while its host is offline is immediate; the relay is removed when the host returns', async t => {
  const h = await relayHarness(t);
  const agent = await h.first.service.create(h.request('codex', 'gate'));
  await waitFor(async () => (await transcript(h.first.service, agent.id)).text.includes('waiting'), 'first output');
  await h.first.service.close();
  const offline = await h.open(); offline.transport.offline = true; await offline.service.resume();
  const started = Date.now();
  await offline.service.delete(agent.id);
  assert.ok(Date.now() - started < 3000, 'an unreachable host does not block deletion');
  assert.equal(offline.store.snapshot().tasks.length, 0);
  assert.equal(offline.store.snapshot().relayCleanups?.length, 1);
  assert.equal((await readdir(h.relays)).length, 1, 'the remote CLI is still running');
  offline.transport.offline = false;
  await offline.service.connect(h.hostId);
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'queued relay removal');
  await waitFor(() => offline.store.snapshot().relayCleanups === undefined, 'cleanup record removal');
});

test('a CLI exit is reported as a failed turn with its error, unlike a lost connection', async t => {
  const h = await relayHarness(t);
  const { service } = h.first;
  const agent = await service.create(h.request('codex', 'exit'));
  const summary = await waitFor(async () => { const s = await service.summary(agent.id); return s.status === 'error' ? s : undefined; }, 'failure');
  assert.match(summary.error!, /simulated crash/);
  const { entries } = await transcript(service, agent.id);
  assert.deepEqual(entries.filter(e => e.item.type === 'turn_end').map(e => e.item.status), ['failed']);
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'relay removal after exit');
  // The next message resumes the native session under a new relay.
  await service.send(agent.id, { id: randomUUID(), text: 'stream 2' });
  await waitFor(async () => (await service.summary(agent.id)).status === 'idle', 'resumed turn');
  assert.match((await transcript(service, agent.id)).text, /c0🌏 c1🌏 $/);
});

test('a forcibly killed DSH loses no remote output: the restarted one resumes from saved history', async t => {
  const { spawn } = await import('node:child_process');
  const { readFile } = await import('node:fs/promises');
  const h = await relayHarness(t);
  await h.first.service.connect(h.hostId); await h.first.service.close();
  const id = `task-${randomUUID()}`, script = new URL('./fixtures/dsh-host.ts', import.meta.url).pathname;
  const child = spawn(process.execPath, ['--import', 'tsx', script, h.home, join(h.root, 'state'), h.hostId, 'claude', 'stream 120', id], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill('SIGKILL'); });
  const events = join(h.root, 'state', 'events', `${id}.jsonl`);
  await waitFor(async () => existsSync(events) && (await readFile(events, 'utf8')).split('\n').filter(line => line.includes('assistant_message')).length > 30, 'output saved by the first DSH', 30_000);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('close', resolve));

  const next = await h.open(); await next.service.resume();
  await waitFor(async () => (await next.service.summary(id)).status === 'idle', 'completion after a crash', 30_000);
  const { text, entries } = await transcript(next.service, id);
  assert.equal(text, Array.from({ length: 120 }, (_, i) => `c${i}🌏 `).join(''), 'Claude partial-message state is restored: nothing is repeated or lost');
  assert.deepEqual(entries.filter(e => e.item.type === 'turn_end').map(e => e.item.status), ['completed']);
  assert.equal((await h.lines('prompts.log')).length, 1);
});

test('a relay started by an interrupted initialization is removed, and retrying starts cleanly once', async t => {
  const h = await relayHarness(t);
  await h.first.service.connect(h.hostId);
  const relayId = randomUUID(), input = h.request('codex', 'stream 2');
  await openRelay(h.first.transport).then(client => client.launch(relayId, h.cwd, [join(h.home, '.local/bin/codex'), 'app-server']));
  const serverId = h.first.store.hosts()[0].serverId!;
  await h.first.store.update(state => { state.tasks.push({ ...input, serverId, title: 'Interrupted', createdAt: new Date().toISOString(), state: 'creating', relay: { id: relayId } }); });
  await h.first.service.close();
  const next = await h.open(); await next.service.resume();
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'stale relay removal');
  assert.equal(next.store.task(t => t.id === input.id)?.relay, undefined);
  const agent = await next.service.create(input);
  assert.equal(agent.started, true);
  await waitFor(async () => (await next.service.summary(agent.id)).status === 'idle', 'retried task');
  assert.equal((await h.lines('prompts.log')).length, 1);
});

test('native DSH conversations: shutdown leaves the turn running; it catches up by itself, the next message shows missed output, and a retry replays all of it', async t => {
  const { ChatProjects } = await import('../src/chat-projects.js');
  const { RemoteCliAdapter, chatModelId, chatProviderId } = await import('../src/native-chat.js');
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const { SessionId } = await import('@deepseek-ai/dsh-session');
  const h = await relayHarness(t);
  await h.first.service.discoverHost(h.hostId);
  const chat = (service: typeof h.first.service) => new RemoteCliAdapter(new ChatProjects(service), { agent: () => ({ id: 'dsh-agent' }), step: () => undefined, cwd: () => h.cwd,
    workspace: async cwd => ({ hostIds: [h.hostId], cwd }), approval: { request: async () => 'allowed-once' }, userQuestions: { ask: async () => ({ answers: [] }) } }, 10);
  const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const options = (session: string, messages: ReturnType<typeof user>[]) => ({ provider: chatProviderId('codex'), model: chatModelId(h.hostId, 'codex', 'fake-model'), sessionId: SessionId(session), messages });
  const first = user('gate'), retried = user('gate'), synced = user('gate');
  const adapter = chat(h.first.service);
  const read = async (stream: AsyncGenerator<{ type: string; text?: string }>, until: string) => {
    let text = '';
    for (;;) { const { value, done } = await stream.next(); if (done) throw new Error('stream ended early'); if (value.type === 'text-delta') text += value.text; if (text.includes(until)) return text; }
  };
  const streams = [adapter.stream(options('conversation-one', [first])), adapter.stream(options('conversation-two', [retried])), adapter.stream(options('conversation-three', [synced]))];
  for (const stream of streams) assert.equal(await read(stream, 'waiting'), 'waiting 🌏 ');
  adapter.close();
  for (const stream of streams) {
    let rest = '', finish: unknown;
    for await (const chunk of stream) { if (chunk.type === 'text-delta') rest += chunk.text; if (chunk.type === 'finish') finish = (chunk as { reason?: unknown }).reason; }
    assert.match(rest, /^\n\nDSH disconnected while the remote CLI was still working/); assert.deepEqual(finish, { kind: 'stop' }, 'shutdown does not fail the DSH turn');
  }
  await h.first.service.close();
  assert.equal((await h.lines('prompts.log')).length, 3);
  await h.gate();

  const next = await h.open(); await next.service.resume();
  const restarted = chat(next.service);
  // DSH opens the third conversation: it wakes once, with a notice, and only while it is routed to the remote CLI.
  const sent: ReturnType<typeof user>[] = [];
  const agent = (session: string, provider = chatProviderId('codex')) => ({ session: { id: SessionId(session), requestHeader: () => ({ config: { provider, model: chatModelId(h.hostId, 'codex', 'fake-model') } }) as never },
    send: (message: ReturnType<typeof user>) => { sent.push(message); } });
  assert.equal(restarted.sync(agent('conversation-three', 'deepseek')), false, 'another model would answer the notice');
  assert.equal(restarted.sync(agent('conversation-three')), true); assert.equal(restarted.sync(agent('conversation-three')), false, 'woken once');
  assert.deepEqual(sent[0].source, { kind: 'remote-cli-sync', form: 'notice', summary: 'Remote CLI output produced while DSH was disconnected' });
  let caught = '', caughtFinish: unknown;
  for await (const chunk of restarted.stream(options('conversation-three', [synced, sent[0]]))) { if (chunk.type === 'text-delta') caught += chunk.text; if (chunk.type === 'finish') caughtFinish = chunk.reason; }
  assert.equal(caught, 'after-gate 你好', 'only the missed output, without resending anything'); assert.deepEqual(caughtFinish, { kind: 'stop' });
  assert.equal(restarted.sync(agent('conversation-three')), false, 'nothing left to catch up');
  let text = '', finish: unknown;
  for await (const chunk of restarted.stream(options('conversation-one', [first, user('stream 2')]))) { if (chunk.type === 'text-delta') text += chunk.text; if (chunk.type === 'finish') finish = chunk.reason; }
  assert.equal(text, 'Output from the previous response, completed while DSH was disconnected:\n\nafter-gate 你好\n\n---\n\nc0🌏 c1🌏 ');
  assert.deepEqual(finish, { kind: 'stop' });
  let replay = '';
  for await (const chunk of restarted.stream(options('conversation-two', [retried]))) if (chunk.type === 'text-delta') replay += chunk.text;
  assert.equal(replay, 'waiting 🌏 after-gate 你好', 'retrying the interrupted response replays its whole receipt');
  const prompts = await h.lines('prompts.log');
  assert.equal(prompts.length, 4, 'nothing was resent or interrupted');
});

test('relay links deliver large payloads once, drop partial frames and keep exact UTF-8 byte offsets', async t => {
  const { RelayLink } = await import('../src/relay.js');
  const { JsonlPeer } = await import('../src/ssh.js');
  const { writeFile, stat } = await import('node:fs/promises');
  const h = await relayHarness(t);
  const echo = join(h.root, 'echo.mjs');
  await writeFile(echo, `let b = Buffer.alloc(0); process.stdin.on('data', d => { b = Buffer.concat([b, d]); let i; while ((i = b.indexOf(10)) >= 0) { const line = b.subarray(0, i); b = b.subarray(i + 1); process.stdout.write(JSON.stringify({ bytes: line.length, head: line.subarray(0, 12).toString(), text: '多字节🌏' }) + '\\n'); } });`);
  const client = await openRelay(h.first.transport), id = randomUUID();
  await client.launch(id, h.cwd, [process.execPath, echo]);
  // A client that disconnects mid-line must not deliver the fragment.
  const raw = h.first.transport.start('/', ['sh', '-c', `exec node "$HOME"/.dsh-remote-agents/relay/relay-*.mjs attach "$HOME/.dsh-remote-agents/relays-v1" "$1" 0`, 'x', id]);
  raw.write('partial-1 {"fragment":'); await new Promise(resolve => setTimeout(resolve, 300)); raw.stop();
  const link = new RelayLink(h.first.transport, id, 0, async () => {}), peer = new JsonlPeer(link), received: { message: Record<string, unknown>; end: number }[] = [];
  peer.onMessage((message, frame) => received.push({ message, end: frame.end }));
  link.open();
  const big = 'x'.repeat(40_000_000);
  peer.send({ big }, 'large-1'); peer.send({ n: 1 }, 'small-1');
  await waitFor(() => received.length >= 2, 'echoed frames', 30_000);
  peer.send({ n: 1 }, 'small-1');
  await new Promise(resolve => setTimeout(resolve, 300));
  link.write('{"n":1}\n', 'small-1');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(received.map(r => r.message.head), ['{"big":"xxxx', '{"n":1}'], 'no fragment and no duplicate reached the CLI');
  assert.equal(received[0].message.bytes, big.length + 10);
  const size = (await stat(join(h.relays, id, 'out.log'))).size;
  assert.equal(received.at(-1)!.end, size, 'frame offsets count bytes, not characters');
  link.stop(); await client.remove([id]);
});

test('deleting a session stops its CLI even when the relay socket path exceeds the platform limit', async t => {
  const h = await relayHarness(t, {}, { longHome: true });
  assert.ok(Buffer.byteLength(join(h.relays, randomUUID(), 'sock')) > 108, 'the absolute socket path is too long to connect to');
  const { service } = h.first;
  const agent = await service.create(h.request('codex', 'gate'));
  await waitFor(async () => (await transcript(service, agent.id)).text.includes('waiting'), 'first output');
  const [daemon, group] = await h.remember();
  await service.delete(agent.id);
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'relay removal');
  await waitFor(() => !h.alive(daemon) && !h.alive(group), 'relay and CLI processes stopped');
  await waitFor(() => h.first.store.snapshot().relayCleanups === undefined, 'cleanup record removal');
});

test('a relay whose socket is unreachable is stopped by its verified process ID before its files are deleted', async t => {
  const { rm: remove } = await import('node:fs/promises');
  const h = await relayHarness(t);
  const { service } = h.first;
  const agent = await service.create(h.request('codex', 'gate'));
  await waitFor(async () => (await transcript(service, agent.id)).text.includes('waiting'), 'first output');
  const [daemon, group] = await h.remember();
  const [id] = await readdir(h.relays);
  await service.close();
  await remove(join(h.relays, id, 'sock'));
  const next = await h.open(); await next.service.resume();
  await next.service.delete(agent.id);
  await waitFor(async () => (await readdir(h.relays)).length === 0, 'relay removal');
  await waitFor(() => !h.alive(daemon) && !h.alive(group), 'relay and CLI processes stopped');
});

test('sessions recover after the relay script is upgraded: the current script is installed before reattaching', async t => {
  const { rm: remove } = await import('node:fs/promises');
  const h = await relayHarness(t);
  const agent = await h.first.service.create(h.request('codex', 'gate'));
  await waitFor(async () => (await transcript(h.first.service, agent.id)).text.includes('waiting'), 'first output');
  await h.first.service.close();
  // An upgraded DSH ships a different script version, which this host does not have yet.
  const scripts = join(h.home, '.dsh-remote-agents', 'relay');
  for (const file of await readdir(scripts)) await remove(join(scripts, file));
  await h.gate();
  const next = await h.open(); await next.service.resume();
  await waitFor(async () => (await next.service.summary(agent.id)).status === 'idle', 'recovery with a reinstalled script', 20_000);
  assert.equal((await transcript(next.service, agent.id)).text, 'waiting 🌏 after-gate 你好');
  // A script removed while attached is reinstalled on the next reconnect.
  for (const file of await readdir(scripts)) await remove(join(scripts, file));
  assert.equal(next.transport.drop(), 1);
  await next.service.send(agent.id, { id: randomUUID(), text: 'stream 2' });
  await waitFor(async () => (await next.service.summary(agent.id)).status === 'idle', 'turn after a second reinstall', 20_000);
  assert.match((await transcript(next.service, agent.id)).text, /c0🌏 c1🌏 $/);
});

test('a relay cleanup that finishes after a plugin reload cannot overwrite the new instance’s state', async t => {
  const { Store } = await import('../src/store.js');
  const h = await relayHarness(t);
  const { service, store, transport } = h.first;
  const agent = await service.create(h.request('codex', 'gate'));
  await waitFor(async () => (await transcript(service, agent.id)).text.includes('waiting'), 'first output');
  // Hold the remote removal, as on a slow SSH host.
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), removing = new Promise<void>(resolve => { entered = resolve; });
  const exec = transport.exec.bind(transport);
  transport.exec = async (script, timeout) => { if (script.includes(' remove ')) { entered(); await held; } return exec(script, timeout); };
  await service.delete(agent.id);
  await removing;
  // Unload as the plugin's disposal does: the service, then its store.
  const started = Date.now();
  await service.close(); await store.close();
  assert.ok(Date.now() - started < 3000, 'shutdown does not wait for a slow remote removal');

  const next = await h.open();
  await next.service.addHost({ label: 'Second host', connection: 'ssh://builder@second-host' });
  release();
  await waitFor(async () => !(await readdir(h.relays)).length, 'the old removal reaches the host');
  await new Promise(resolve => setTimeout(resolve, 300));
  const disk = new Store(join(h.root, 'state', 'state.json')); await disk.open();
  assert.equal(disk.hosts().length, 2, 'the new host survives the old instance’s late cleanup');
  assert.equal(disk.snapshot().relayCleanups?.length, 1, 'the old instance recorded nothing after closing');
  await assert.rejects(store.update(() => {}), /closed/);
  // The new instance finishes the queued cleanup; removing an already removed relay succeeds.
  await next.service.resume();
  await waitFor(() => next.store.snapshot().relayCleanups === undefined, 'cleanup record removal by the new instance');
});
