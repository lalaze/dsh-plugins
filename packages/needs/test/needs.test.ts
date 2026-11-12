import assert from 'node:assert/strict';
import test from 'node:test';
import { install, offerFor, type Remote } from '../src/index.js';

type Entry = { name: string; versions: { version: string; install: { spec: string; registry?: string } }[]; defaultVersion?: string; installation?: { status: 'not-installed' | 'installed' | 'update-available' | 'different-version' | 'provided'; installedVersion?: string } };
function remoteWith(markets: Record<string, Entry[] | 'down'>, installs: { spec: string; options: unknown }[] = [], change: unknown = { application: 'applied' }): Remote {
  return {
    pluginMarket: {
      listIndexes: async () => ({ ok: true, value: Object.keys(markets).map(url => ({ url })) }),
      search: async (url, query) => {
        const entries = markets[url];
        if (entries === 'down') return { ok: false, error: { message: 'fetch failed' } };
        const page = entries.slice(query.offset, query.offset + query.limit);
        return { ok: true, value: { entries: page, nextOffset: query.offset + query.limit < entries.length ? query.offset + query.limit : null } };
      },
    },
    pluginManager: { installBundle: async (spec, options) => { installs.push({ spec, options }); return { ok: true, value: change as never }; } },
  };
}
const flow = (status: NonNullable<Entry['installation']>['status'], installedVersion?: string): Entry => ({
  name: 'dsh-model-flow', defaultVersion: '0.1.8',
  versions: [{ version: '0.1.8', install: { spec: 'git+https://example.test/m.git#abc&path:/packages/model-flow' } }, { version: '0.1.7', install: { spec: 'old' } }],
  installation: { status, ...(installedVersion ? { installedVersion } : {}) },
});

test('a plugin no market lists, and a page that cannot ask', async () => {
  assert.deepEqual(await offerFor(remoteWith({ a: [] }), 'dsh-model-flow'), { kind: 'unlisted', name: 'dsh-model-flow' });
  assert.deepEqual(await offerFor(undefined, 'dsh-model-flow'), { kind: 'unavailable', name: 'dsh-model-flow' });
  assert.deepEqual(await offerFor({}, 'dsh-model-flow'), { kind: 'unavailable', name: 'dsh-model-flow' });
});

test('the offer is the version this DSH accepts, from the first market that has it', async () => {
  // The search is fuzzy: a similar name must not be taken for the plugin.
  const near: Entry = { ...flow('not-installed'), name: 'dsh-model-flows' };
  const remote = remoteWith({ down: 'down', other: [near], mine: [near, flow('not-installed')] });
  assert.deepEqual(await offerFor(remote, 'dsh-model-flow'), { kind: 'install', name: 'dsh-model-flow', version: '0.1.8', spec: 'git+https://example.test/m.git#abc&path:/packages/model-flow' });
  assert.deepEqual(await offerFor(remoteWith({ mine: [flow('update-available', '0.1.7')] }), 'dsh-model-flow'),
    { kind: 'update', name: 'dsh-model-flow', version: '0.1.8', spec: 'git+https://example.test/m.git#abc&path:/packages/model-flow', installed: '0.1.7' });
});

test('a plugin found beyond the first page of results', async () => {
  const filler = Array.from({ length: 60 }, (_, index): Entry => ({ ...flow('not-installed'), name: `dsh-model-flow-${index}` }));
  assert.equal((await offerFor(remoteWith({ mine: [...filler, flow('not-installed')] }), 'dsh-model-flow')).kind, 'install');
});

test('installed already, or no version for this DSH', async () => {
  assert.deepEqual(await offerFor(remoteWith({ mine: [flow('installed', '0.1.8')] }), 'dsh-model-flow'), { kind: 'present', name: 'dsh-model-flow', installed: '0.1.8' });
  const { defaultVersion: _none, ...incompatible } = flow('not-installed');
  assert.deepEqual(await offerFor(remoteWith({ mine: [incompatible] }), 'dsh-model-flow'), { kind: 'unlisted', name: 'dsh-model-flow' });
  // Another market can still offer it.
  assert.equal((await offerFor(remoteWith({ mine: [flow('installed', '0.1.8')], next: [flow('not-installed')] }), 'dsh-model-flow')).kind, 'install');
});

test('installing asks the plugin manager for that exact version, switched on', async () => {
  const installs: { spec: string; options: unknown }[] = [];
  const remote = remoteWith({ mine: [{ ...flow('not-installed'), versions: [{ version: '0.1.8', install: { spec: 'dsh-model-flow@0.1.8', registry: 'https://registry.example.test/' } }] }] }, installs);
  const offer = await offerFor(remote, 'dsh-model-flow');
  assert.equal(offer.kind, 'install');
  if (offer.kind !== 'install') return;
  assert.deepEqual(await install(remote, offer), { kind: 'applied' });
  assert.deepEqual(installs, [{ spec: 'dsh-model-flow@0.1.8', options: { enabled: true, registry: 'https://registry.example.test/' } }]);
});

test('an update takes effect at the next start, and a refusal says why', async () => {
  const update = { kind: 'update', name: 'x', version: '2', spec: 'x@2' } as const, fresh = { ...update, kind: 'install' } as const;
  assert.deepEqual(await install(remoteWith({}), update), { kind: 'restart' });
  assert.deepEqual(await install(remoteWith({}, [], { application: 'restart-required' }), fresh), { kind: 'restart' });
  assert.deepEqual(await install(remoteWith({}, [], { application: 'failed', error: { code: 'incompatible-version', diagnostic: 'needs DSH 0.3' } }), fresh), { kind: 'failed', detail: 'needs DSH 0.3' });
  assert.deepEqual(await install(remoteWith({}, [], { application: 'failed', error: { code: 'operation-error' }, pendingBuilds: ['esbuild'] }), fresh),
    { kind: 'failed', detail: 'operation-error Scripts of esbuild wait for approval on the Plugins page.' });
  assert.deepEqual(await install({ pluginManager: { installBundle: async () => ({ ok: false, error: { message: 'not allowed' } }) } }, fresh), { kind: 'failed', detail: 'not allowed' });
  assert.deepEqual(await install({ pluginManager: { installBundle: async () => { throw new Error('connection lost'); } } }, fresh), { kind: 'failed', detail: 'connection lost' });
});
