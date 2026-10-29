import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatProjects } from '../src/chat/projects.js';
import { Store } from '../src/core/store.js';
import { createHandler } from '../src/http.js';
import { fixture } from './fakes.js';

test('a machine can be saved without starting discovery until a CLI is selected', async t => {
  const { service, remote } = await fixture(t);
  remote.homeError = 'Discovery must not run';
  const saved = await service.addHost({ label: 'Choose later', connection: 'ssh://choose-later', enabledProviders: [] }, { discoverModels: true });
  const host = saved.hosts.at(-1)!;
  assert.deepEqual(host.enabledProviders, []); assert.equal(host.modelCount, 0); assert.equal(host.modelError, undefined);
  assert.equal(remote.discoveries, 0); assert.equal(remote.creates, 0);
});

test('CLI selection persists, hides disabled errors and leaves existing agents running', async t => {
  const { service, remote, hostId, request, path } = await fixture(t);
  remote.catalog.push({ id: 'antigravity', label: 'Antigravity', status: 'error', error: 'Old Node', models: [], modes: [] });
  await service.discoverHost(hostId);
  assert.equal(service.hosts()[0].providerErrors?.length, 1);
  const host = (await service.setHostProviders(hostId, ['codex'])).hosts[0];
  assert.deepEqual(host.enabledProviders, ['codex']); assert.deepEqual(host.providerErrors, []); assert.equal(host.modelCount, 1);
  assert.deepEqual(new ChatProjects(service).hosts()[0].providers.map(p => p.id), ['codex']);
  const reopened = new Store(path); await reopened.open(); assert.deepEqual(reopened.hosts()[0].enabledProviders, ['codex']);
  remote.onCreate = agent => { agent.status = 'running'; };
  const agent = await service.create(request());
  const probes = remote.discoveries;
  await service.setHostProviders(hostId, []);
  assert.equal(remote.discoveries, probes); assert.equal(remote.stops, 0);
  assert.equal((await service.summary(agent.id)).status, 'running');
  assert.deepEqual(new ChatProjects(service).hosts()[0].providers, []);
  await assert.rejects(service.create(request()), /disabled on this machine/);
});

test('the HTTP selection action validates IDs and scans only the selected catalog', async t => {
  const { service, hostId, remote } = await fixture(t), handle = createHandler(service);
  const post = (providers: unknown) => handle(new Request('http://dsh.test/api/remote-agents', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify({ action: 'setHostProviders', hostId, providers }) }));
  assert.equal((await post(['unknown-cli'])).status, 400); assert.equal(remote.discoveries, 0);
  assert.equal((await post('codex')).status, 400);
  assert.equal((await post(['codex', 'codex'])).status, 200);
  assert.deepEqual(service.hosts()[0].enabledProviders, ['codex']);
});
