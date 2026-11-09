import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { JSDOM } from 'jsdom';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NativePlacements, nativeLocalDirectory, type NativeRuntimePlacement } from '../src/chat/native-placement.js';
import { NativeSharing, type NativeHost } from '../src/chat/native-service.js';
import { nativeDigest, type NativeSnapshot } from '../src/chat/native-protocol.js';
import { createHandler } from '../src/http.js';
import { NativeSharingSettings } from '../src/client/settings/native-sharing.js';
import { fixture } from './fakes.js';

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'native-placement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'air'), target = join(root, 'mini'), other = join(root, 'other');
  await Promise.all([mkdir(source), mkdir(target), mkdir(other)]);
  return { root, source: nativeLocalDirectory(source), target: nativeLocalDirectory(target), other: nativeLocalDirectory(other) };
}
const input = (body: object, authenticated = true) => new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'X-DSH-Remote-Agents': '1' } : {}) }, body: JSON.stringify(body) });
async function rig(t: TestContext) {
  const x = await fixture(t), dirs = await directory(t), id = 'local-source';
  const session = Session.create(SessionId(id));
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `Keep history path ${dirs.source}/file.ts` }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'ordinary', model: 'configured' } }, reason: 'initial' } as never);
  const project = '/source-machine/project';
  const snapshot = (): NativeSnapshot => ({ protocol: 'shared-native-v1', header: { ...session.header, cwd: dirs.source }, inheritedEventCount: 0, project, title: 'Local project', events: structuredClone([...session.snapshotEvents()]), files: [] });
  let sealed = 0, claimed = 0, imported = 0;
  let record: any = { id: 'shared-project', snapshot: snapshot(), version: 1, digest: nativeDigest(snapshot().events), owner: null };
  const placements: NativeRuntimePlacement[] = [], importedSnapshots: NativeSnapshot[] = [];
  let native: NativeSharing;
  const host: NativeHost = {
    available: () => true, sourceDirectory: async () => dirs.source,
    placement: async (_id, hostId) => native.placements.source(hostId, dirs.source),
    resolvePlacement: async (hostId, key) => key === '/legacy' ? { kind: 'remote', project: key } : native.placements.receiver(hostId, key),
    snapshot: async (_id, key) => ({ ...snapshot(), project: key }), idle: async (_id, run) => run(), validate: async () => {},
    import: async (_id, _host, value, _mirror, placement) => { imported++; if (placement) placements.push(placement); importedSnapshots.push(structuredClone(value)); },
    activate: async () => {}, seal: async () => { sealed++; },
  };
  const rpc: ConstructorParameters<typeof NativeSharing>[2] = { call: async (_host, request) => {
    if (request.action === 'list') return [{ id: record.id, project: record.snapshot.project, title: 'Local project', version: record.version, owner: record.owner, archived: false, deleted: false }];
    if (request.action === 'get') return structuredClone(record);
    if (request.action === 'create') { record = { ...record, snapshot: request.snapshot, id: request.id }; return structuredClone(record); }
    if (request.action === 'claim') { claimed++; record.owner = 'test-instance'; record.token = request.token; record.version++; return structuredClone(record); }
    if (request.action === 'release') { record.owner = null; record.version++; return structuredClone(record); }
    if (request.action === 'check') return {};
    throw Error(`Unexpected ${request.action}`);
  } };
  native = new NativeSharing(join(dirs.root, 'replicas.json'), 'test-instance', rpc, host);
  t.after(() => native.close());
  const handler = createHandler(x.service, undefined, undefined, undefined, undefined, undefined, undefined, native);
  return { ...x, ...dirs, id, project, native, host, rpc, handler, placements, importedSnapshots, record: () => record, snapshot, counts: () => ({ sealed, claimed, imported }) };
}

test('mapping store requires canonical confirmation, existing absolute directory, unique source and host scope; persists privately', async t => {
  const x = await directory(t), path = join(x.root, 'mapping.json'), store = new NativePlacements(path), alias = join(x.root, 'alias');
  await symlink(x.target, alias);
  assert.throws(() => store.set('host', '/source', 'relative', 'relative'), /absolute/);
  assert.throws(() => store.set('host', '/source', join(x.root, 'missing'), ''), /existing/);
  const file = join(x.root, 'file'); await writeFile(file, 'fixture');
  assert.throws(() => store.set('host', '/source', file, file), /directory/);
  assert.throws(() => store.set('host', '/source', alias, alias), /canonical/);
  store.set('host', '/source', alias, x.target);
  assert.equal(store.source('host', alias), '/source');
  assert.equal(store.receiver('host', '/source').localDirectory, x.target);
  assert.throws(() => store.receiver('other-host', '/source'), /mapping required/);
  assert.throws(() => store.set('host', '/second', x.target, x.target), /already mapped/);
  assert.deepEqual(new NativePlacements(path).list('host'), store.list('host'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort(), ['mappings', 'schema']);
});

test('mapped directories are revalidated, never guessed from project key or directory basename', async t => {
  const x = await directory(t), store = new NativePlacements(join(x.root, 'mapping.json'));
  assert.throws(() => store.receiver('host', x.target), /mapping required/);
  store.set('host', '/project', x.target, x.target);
  await rm(x.target, { recursive: true }); await symlink(x.other, x.target);
  assert.throws(() => store.receiver('host', '/project'), /changed/);
});

test('missing source/receiver mappings preserve original and discoverable history without claim or import', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true);
  await assert.rejects(x.native.share(x.id, x.hostId), /mapping required/);
  await assert.rejects(x.native.open(x.hostId, 'shared-project', true), /mapping required/);
  assert.equal((await x.native.list(x.hostId))[0].project, x.project);
  assert.equal(x.native.status().replicas.length, 0);
  await x.native.sync();
  assert.match(x.native.status().errors[`${x.hostId}/shared-project`], /mapping required/);
  assert.deepEqual(x.counts(), { sealed: 0, claimed: 0, imported: 0 });
  await x.native.setMapping(x.hostId, x.project, x.target, x.target);
  await x.native.open(x.hostId, 'shared-project', false);
  assert.equal(x.native.status().errors[`${x.hostId}/shared-project`], undefined);
});

test('source reverse lookup and different receiver directory preserve history; active/restarted remap is refused until handoff', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true);
  await x.native.setMapping(x.hostId, x.project, x.source, x.source);
  assert.equal((await x.native.sourceProject(x.id, x.hostId)).projectKey, x.project);
  await x.native.share(x.id, x.hostId);
  assert.equal(x.record().snapshot.project, x.project);
  assert.equal(x.record().snapshot.projectKind, 'local');
  assert.equal(x.record().snapshot.header.cwd, x.project);
  await x.native.setMapping(x.hostId, x.project, x.target, x.target);
  const active = await x.native.open(x.hostId, x.record().id, true);
  assert.deepEqual(x.placements[0], { kind: 'local', project: x.project, localDirectory: x.target });
  assert.deepEqual(x.importedSnapshots[0].events, x.snapshot().events);
  assert.match(JSON.stringify(x.importedSnapshots[0].events), new RegExp(x.source));
  await assert.rejects(x.native.setMapping(x.hostId, x.project, x.other, x.other), /Active project remap refused/);
  await x.native.setMapping(x.hostId, x.project, x.target, x.target);
  const restarted = new NativeSharing(x.native.path, 'restart', { call: async () => ({}) }, x.host); t.after(() => restarted.close());
  await assert.rejects(restarted.setMapping(x.hostId, x.project, x.other, x.other), /Active project remap refused/);
  assert.deepEqual(restarted.replica(active.sessionId)?.placement, x.placements[0]);
  await x.native.handoff(active.sessionId);
  await x.native.setMapping(x.hostId, x.project, x.other, x.other);
  assert.deepEqual(x.native.replica(active.sessionId)?.placement, x.placements[0], 'closed copies retain their original binding');
});

test('remote placement fallback remains available without local mapping', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true); x.record().snapshot.project = '/legacy';
  await x.native.open(x.hostId, 'shared-project', false);
  assert.deepEqual(x.placements[0], { kind: 'remote', project: '/legacy' });
});

test('a marked local project never falls back to a remote workspace when its mapping is missing', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true);
  x.record().snapshot.project = '/legacy'; x.record().snapshot.projectKind = 'local';
  await assert.rejects(x.native.open(x.hostId, 'shared-project', true), /mapping required/);
  assert.deepEqual(x.counts(), { sealed: 0, claimed: 0, imported: 0 });
  assert.equal((await x.native.list(x.hostId)).length, 1);
});

test('mapping HTTP requires opted-in host, API authentication and exact directory confirmation', async t => {
  const x = await rig(t), data = { hostId: x.hostId, projectKey: x.project, localDirectory: x.target };
  assert.equal((await x.handler(input({ action: 'setNativeMapping', ...data, confirmed: true, confirmedDirectory: x.target }, false))).status, 403);
  assert.equal((await x.handler(input({ action: 'nativeMappings', ...data }))).status, 409);
  await x.native.configure(x.hostId, true);
  assert.equal((await x.handler(input({ action: 'nativeMappings', hostId: 'missing-host' }))).status, 404);
  assert.equal((await (await x.handler(input({ action: 'inspectNativeMapping', ...data }))).json()).localDirectory, x.target);
  for (const confirmation of [{}, { confirmed: true, confirmedDirectory: x.other }]) assert.notEqual((await x.handler(input({ action: 'setNativeMapping', ...data, ...confirmation }))).status, 200);
  assert.deepEqual(x.native.mappings(x.hostId), []);
  assert.equal((await x.handler(input({ action: 'setNativeMapping', ...data, confirmed: true, confirmedDirectory: x.target }))).status, 200);
  assert.equal((await (await x.handler(input({ action: 'nativeMappings', hostId: x.hostId }))).json())[0].localDirectory, x.target);
});

test('mapping UI verifies target and displays mapping; cancelled confirmation sends no save', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true);
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://dsh.test/' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), requests: any[] = [];
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : name === 'fetch' ? async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return x.handler(new Request('http://dsh.test/api/remote-agents', init)); } : (dom.window as any)[name] });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); for (const name of names) { const prior = originals.get(name); if (prior) Object.defineProperty(globalThis, name, prior); else delete (globalThis as any)[name]; } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 15));
  await act(async () => { root.render(<NativeSharingSettings dashboard={await x.service.snapshot()} sessionId={x.id} />); await settle(); });
  const select = dom.window.document.querySelector('select')!;
  await act(async () => { select.value = x.hostId; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle(); });
  const button = (text: string) => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === text)!;
  assert.match(dom.window.document.body.textContent!, /Project mapping required/);
  await act(async () => { button('Map this project').click(); await settle(); });
  const field = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Local absolute directory"]')!;
  await act(async () => { Simulate.change(field, { target: { value: x.target } } as any); await settle(); });
  let prompt = ''; dom.window.confirm = message => { prompt = String(message); return false; };
  await act(async () => { button('Verify and confirm directory').click(); await settle(); });
  assert.match(prompt, new RegExp(x.target)); assert.match(prompt, new RegExp(x.project));
  assert.ok(requests.some(r => r.action === 'inspectNativeMapping'));
  assert.ok(!requests.some(r => r.action === 'setNativeMapping'));
  dom.window.confirm = () => true;
  await act(async () => { button('Verify and confirm directory').click(); await settle(); });
  assert.equal(x.native.mappings(x.hostId)[0].localDirectory, x.target);
  assert.match(dom.window.document.body.textContent!, new RegExp(x.target));
  assert.equal(requests.find(r => r.action === 'setNativeMapping').confirmedDirectory, x.target);
});

test('one missing mapping does not prevent sync from discovering and importing another project', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true);
  // Two summaries share a fake authority; get returns the requested snapshot.
  const rpc = x.rpc, call = rpc.call;
  rpc.call = async (hostId: string, request: any) => {
    if (request.action === 'list') return [{ id: 'unmapped', project: x.project }, { id: 'remote-mapped', project: '/legacy' }];
    if (request.action === 'get') return { ...x.record(), snapshot: { ...x.snapshot(), project: request.id === 'unmapped' ? x.project : '/legacy' } };
    return call(hostId, request);
  };
  await x.native.sync();
  assert.equal(x.counts().imported, 1);
  assert.deepEqual(x.placements, [{ kind: 'remote', project: '/legacy' }]);
  assert.match(x.native.status().errors[`${x.hostId}/unmapped`], /mapping required/);
});

test('inflight import pins its directory and refuses remap; dispatch rechecks directory identity', async t => {
  const x = await rig(t); await x.native.configure(x.hostId, true);
  await x.native.setMapping(x.hostId, x.project, x.target, x.target);
  let resume!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { resume = resolve; });
  const importSnapshot = x.host.import;
  x.host.import = async (...args) => { started(); await blocked; await importSnapshot(...args); };
  const opening = x.native.open(x.hostId, 'shared-project', true);
  await entered;
  await assert.rejects(x.native.setMapping(x.hostId, x.project, x.other, x.other), /Active project remap refused/);
  resume(); const active = await opening;
  await x.native.guard(active.sessionId);
  await rm(x.target, { recursive: true }); await symlink(x.other, x.target);
  await assert.rejects(x.native.guard(active.sessionId), /Bound local directory changed/);
  assert.equal(x.native.replica(active.sessionId)?.placement?.kind, 'local');
});
