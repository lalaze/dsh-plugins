import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { relayHarness, transcript, waitFor } from './relay-harness.js';
import { RELAY_UNAVAILABLE } from '@dsh-plugins/remote-core/domain.js';
import { REMOTE_HOME, remoteScript } from '@dsh-plugins/remote-core/remote-host.js';
import { RELAY_SCRIPT, RELAY_VERSION } from '../src/agents/relay.js';

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

test('an old-node install probe prevents CLI startup and reports the reason', async t => {
  const h = await relayHarness(t);
  // A bad PATH Node no longer rules out usable system/NVM fallbacks. Simulate only the
  // install probe's result here; real wrapper execution and fake CLI discovery remain intact.
  const install = remoteScript('relay', RELAY_VERSION, RELAY_SCRIPT, { directories: [`${REMOTE_HOME}/relays-v1`] }).install;
  const { transport, service } = h.first, exec = transport.exec.bind(transport);
  let probes = 0;
  t.mock.method(transport, 'exec', async (...args: Parameters<typeof transport.exec>) => {
    if (args[0] === install) { probes++; return 'old-node'; }
    return exec(...args);
  });
  const agent = await service.create(h.request('claude', 'stream 1'));
  assert.equal(probes, 1, 'only the relay installation probe is simulated');
  assert.equal(agent.started, false); assert.equal(agent.error, RELAY_UNAVAILABLE['old-node']);
  assert.equal(existsSync(h.relays), false, 'no relay was installed');
  assert.deepEqual(await h.lines('prompts.log'), [], 'no CLI turn was started');
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
