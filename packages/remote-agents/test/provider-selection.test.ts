import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatProjects } from '../src/chat/projects.js';
import { Store } from '../src/core/store.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createHandler } from '../src/http.js';
import { CATALOG_MAX_AGE_MS, RemoteAgentsService } from '../src/agents/service.js';
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
  remote.catalog.push({ id: 'grok', label: 'Grok', status: 'error', error: 'Not signed in', models: [], modes: [] });
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

test('a saved selection naming a CLI the plugin no longer has still opens, without that CLI', async t => {
  const { service, hostId, path, store } = await fixture(t);
  await service.setHostProviders(hostId, ['codex', 'grok']);
  // As a version that had another CLI saved it: that CLI enabled, with its models in the catalog.
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.hosts[0].enabledProviders.push('retired-cli');
  saved.hosts[0].catalog.providers.push({ id: 'retired-cli', label: 'Retired CLI', status: 'ready', models: [{ id: 'retired-model', label: 'Retired model' }], modes: [] });
  await store.close(); await writeFile(path, JSON.stringify(saved));
  const reopened = new Store(path); await reopened.open(); t.after(() => reopened.close());
  assert.deepEqual(reopened.hosts()[0].enabledProviders, ['codex', 'grok']);
  // A machine left on "all CLIs" offers what this version has.
  delete saved.hosts[0].enabledProviders; await reopened.close(); await writeFile(path, JSON.stringify(saved));
  const all = new Store(path); await all.open(); t.after(() => all.close());
  assert.ok(!new ChatProjects({ store: all, onCatalogChange: () => () => {} } as never).hosts()[0].providers.some(p => p.id === 'retired-cli'));
});

test('Antigravity models saved by 0.2.129 or earlier are dropped on opening, and that machine is discovered again', async t => {
  const { service, remote, hostId, path, store } = await fixture(t);
  await service.discoverHost(hostId);
  // As 0.2.129 saved a machine left on all CLIs: `agy models` IDs and the notice only that integration set.
  const saved = JSON.parse(await readFile(path, 'utf8')), current = saved.hosts[0].catalog.providers.map((p: { id: string }) => p.id);
  delete saved.hosts[0].enabledProviders;
  saved.hosts[0].catalog.providers.push({ id: 'antigravity', label: 'Antigravity', status: 'ready', notice: 'Antigravity headless mode denies operations that require interactive approval.',
    models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }, { id: 'claude-sonnet-4-6-thinking', label: 'Claude Sonnet 4.6 (Thinking)' }], defaultModeId: 'default',
    modes: [{ id: 'default', label: 'CLI permission settings' }, { id: 'plan', label: 'Plan' }] });
  await service.close(); await store.close(); await writeFile(path, JSON.stringify(saved));
  const reopened = new Store(path); await reopened.open();
  assert.deepEqual([...reopened.staleCatalogs], [hostId]);
  assert.deepEqual(reopened.hosts()[0].catalog!.providers.map(p => p.id), current);
  remote.store = reopened;
  const again = new RemoteAgentsService(reopened, remote.backend); t.after(async () => { await again.close(); await reopened.close(); });
  assert.ok(!new ChatProjects(again).hosts()[0].providers.some(p => p.id === 'antigravity'), 'the old models are never offered');
  // What `agy acp` reports now.
  remote.catalog.push({ id: 'antigravity', label: 'Antigravity', status: 'ready', models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }], modes: [{ id: 'default', label: 'Default' }] });
  const probes = remote.discoveries;
  await again.refreshStaleCatalogs();
  assert.equal(remote.discoveries, probes + 1); assert.equal(reopened.staleCatalogs.size, 0);
  assert.deepEqual(new ChatProjects(again).hosts()[0].providers.find(p => p.id === 'antigravity')!.models.map(m => m.id), ['gemini-3.8-flash']);
  // Saved again, nothing is left to drop, and an Antigravity entry from `agy acp` is kept.
  const third = new Store(path); await third.open(); t.after(() => third.close());
  assert.equal(third.staleCatalogs.size, 0); assert.ok(third.hosts()[0].catalog!.providers.some(p => p.id === 'antigravity'));
  await again.refreshStaleCatalogs(); assert.equal(remote.discoveries, probes + 1, 'nothing to discover a second time');
});

test('a machine a conversation works on has its saved models checked again once they are an hour old', async t => {
  const { service, remote, hostId } = await fixture(t);
  await service.refreshAgedCatalogs([hostId], Date.now() + 10 * CATALOG_MAX_AGE_MS);
  assert.equal(remote.discoveries, 0, 'a machine never discovered waits for Refresh models');
  await service.discoverHost(hostId);
  const discovered = Date.parse(service.store.hosts()[0].catalog!.checkedAt);
  const models = () => new ChatProjects(service).hosts()[0].providers.find(p => p.id === 'codex')!.models.map(m => m.id);
  remote.catalog[0].models.push({ id: 'new-model', label: 'New model' });
  const probes = remote.discoveries;
  await service.refreshAgedCatalogs([hostId], discovered + CATALOG_MAX_AGE_MS - 1);
  assert.equal(remote.discoveries, probes, 'models under an hour old are not checked');
  await service.refreshAgedCatalogs([hostId, hostId], discovered + CATALOG_MAX_AGE_MS);
  assert.equal(remote.discoveries, probes + 1); assert.deepEqual(models(), ['remote-model', 'new-model']);
  // The composer asks on every window focus: a machine is checked once per period, whatever the outcome.
  await service.refreshAgedCatalogs([hostId], discovered + CATALOG_MAX_AGE_MS + 1);
  assert.equal(remote.discoveries, probes + 1);
  // A CLI that fails this once keeps its saved models, and nobody asked to be told.
  remote.catalog[0] = { ...remote.catalog[0], status: 'error', error: 'Not signed in', models: [] };
  await service.refreshAgedCatalogs([hostId], discovered + 2 * CATALOG_MAX_AGE_MS);
  assert.equal(remote.discoveries, probes + 2); assert.deepEqual(models(), ['remote-model', 'new-model']);
  assert.deepEqual(service.hosts()[0].providerErrors, []);
  // So does a machine that cannot be reached.
  remote.homeError = 'Machine is offline';
  await service.refreshAgedCatalogs([hostId], discovered + 3 * CATALOG_MAX_AGE_MS);
  assert.equal(service.hosts()[0].modelError, undefined); assert.deepEqual(models(), ['remote-model', 'new-model']);
  // Refresh models still reports both, and drops what the CLI no longer offers.
  await service.discoverHost(hostId);
  assert.match(service.hosts()[0].modelError ?? '', /Machine is offline/);
  remote.homeError = undefined; await service.discoverHost(hostId);
  assert.equal(service.hosts()[0].modelError, undefined); assert.equal(service.hosts()[0].providerErrors?.length, 1);
  assert.equal(new ChatProjects(service).hosts()[0].providers.find(p => p.id === 'codex')?.status, 'error');
});

test('a machine with no CLI enabled, or a stopped service, is not checked in the background', async t => {
  const { service, remote, hostId } = await fixture(t);
  await service.discoverHost(hostId);
  const later = Date.parse(service.store.hosts()[0].catalog!.checkedAt) + 2 * CATALOG_MAX_AGE_MS, probes = remote.discoveries;
  await service.setHostProviders(hostId, []);
  await service.refreshAgedCatalogs([hostId], later);
  assert.equal(remote.discoveries, probes);
  await service.setHostProviders(hostId, ['codex']);
  const enabled = remote.discoveries;
  await service.close();
  await service.refreshAgedCatalogs([hostId], later);
  assert.equal(remote.discoveries, enabled);
});
