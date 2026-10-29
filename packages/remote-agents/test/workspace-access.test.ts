import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { hostname, userInfo } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index.js';
import { fixture } from './fakes.js';
import { WorkspaceAccess } from '../src/workspace/access.js';
import { SshBackend } from '../src/agents/backend.js';

test('workspace models match SSH host, user and port and translate placeholder subdirectories', async t => {
  const { directory, store, hostId, service } = await fixture(t);
  await service.addHost({ label: 'Other machine', connection: 'ssh://builder@other-box' });
  await service.addHost({ label: 'Other user', connection: 'ssh://root@build-box' });
  await service.addHost({ label: 'Other port', connection: 'ssh://builder@build-box:2222' });
  const omc = join(directory, 'omc'), path = join(omc, 'remote-workspaces', 'project');
  await mkdir(join(path, 'src'), { recursive: true });
  const bindings = join(omc, 'remote-workspaces.json');
  await writeFile(bindings, JSON.stringify([{ path, host: 'build-alias', remoteCwd: '/srv/app', workspaceId: 'workspace-one' }]));
  const endpoint = async (connection: string) => {
    if (connection === 'build-alias') return { host: 'build-box', username: 'builder', port: 22 };
    const url = new URL(connection);
    return { host: url.hostname, username: url.username, port: Number(url.port || 22) };
  };
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc, endpoint });
  assert.deepEqual(await access.resolve(join(path, 'src')), { hostIds: [hostId], cwd: '/srv/app/src' });
  assert.deepEqual(await access.resolve('/some/local/project'), { hostIds: [] });
  await writeFile(bindings, '[]');
  assert.deepEqual(await access.resolve(path), { hostIds: [] }, 'removed bindings cannot reuse previous admission');
});

test('dsh-remote mirrors use their registered endpoint, reject malformed metadata and escaped paths', async t => {
  const { directory, store, hostId } = await fixture(t);
  const mirror = join(directory, 'remote-workspaces', 'machine', 'project');
  await mkdir(join(mirror, 'src'), { recursive: true });
  const metadata = join(mirror, '.dsh-remote-meta.json');
  await writeFile(metadata, JSON.stringify({ host: 'build-box', username: 'builder', port: 22, remotePath: '/srv/app' }));
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'),
    endpoint: async () => ({ host: 'build-box', username: 'builder', port: 22 }) });
  assert.deepEqual(await access.resolve(join(mirror, 'src')), { hostIds: [hostId], cwd: '/srv/app/src' });
  await symlink(directory, join(mirror, 'outside'));
  await assert.rejects(access.resolve(join(mirror, 'outside')), /binding/);
  await writeFile(metadata, '{}');
  await assert.rejects(access.resolve(mirror), /binding/);
});

test('binding changes during endpoint resolution cannot admit an old machine', async t => {
  const { directory, store } = await fixture(t);
  const path = join(directory, 'remote-workspaces', 'machine', 'project');
  await mkdir(path, { recursive: true });
  const metadata = join(path, '.dsh-remote-meta.json');
  await writeFile(metadata, JSON.stringify({ host: 'build-box', username: 'builder', remotePath: '/srv/app' }));
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'), endpoint: async () => {
    await writeFile(metadata, JSON.stringify({ host: 'other-box', username: 'builder', remotePath: '/srv/app' }));
    return { host: 'build-box', username: 'builder', port: 22 };
  } });
  await assert.rejects(access.resolve(path), /changed/);
});

test('process-routed workspaces match the saved machine identity and reject local execution', async t => {
  const { directory, store, hostId } = await fixture(t);
  const identity = ['remote-fixture-machine', 'builder', 'unique-fixture-machine'];
  await store.update(state => { state.hosts[0].serverId = `ssh-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`; });
  let output = [...identity, '/srv/actual-project', ''].join('\0');
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'), runtime: () => ({
    spawn(spec) {
      assert.equal(spec.cwd, '/virtual/workspace');
      const stdout = new PassThrough(), stderr = new PassThrough();
      const done = new Promise<{ exitCode: number }>(resolve => queueMicrotask(() => { stdout.end(output); stderr.end(); resolve({ exitCode: 0 }); }));
      return { stdout, stderr, done, terminate() { stdout.destroy(); stderr.destroy(); } };
    },
  }) });
  assert.deepEqual(await access.resolve('/virtual/workspace'), { hostIds: [hostId], cwd: '/srv/actual-project' });
  output = [hostname(), userInfo().username, 'local-machine', directory, ''].join('\0');
  assert.deepEqual(await access.resolve('/virtual/workspace'), { hostIds: [] });
  output = 'invalid'; await assert.rejects(access.resolve('/virtual/workspace'), /identity/);
});

test('plugin startup leaves saved relay sessions and their SSH hosts dormant', async t => {
  const { directory, service, store, request } = await fixture(t);
  const agent = await service.create(request());
  await store.update(state => {
    const task = state.tasks.find(task => task.id === agent.id)!;
    task.relay = { id: randomUUID() };
    task.native = { protocol: 'codex', sessionId: 'saved-native-session', argv: ['codex', 'app-server'], initialSent: true };
  });
  await service.close();
  const restore = t.mock.method(SshBackend.prototype, 'restore', async () => null);
  const share = t.mock.method(SshBackend.prototype, 'startSharing', () => {});
  const cleanup = t.mock.method(SshBackend.prototype, 'cleanup', async () => {});
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('connection', { fetch: { register() {} } });
  const mounted = ctx.plugin(plugin, { stateDir: directory }); await mounted.await();
  assert.equal(restore.mock.callCount(), 0, 'startup does not attach saved CLIs');
  assert.equal(share.mock.callCount(), 0, 'startup does not connect shared registries');
  assert.equal(cleanup.mock.callCount(), 0, 'startup does not probe hosts for relay cleanup');
});

test('the mounted workspace API uses live or persisted session placement and rejects a concurrent switch', async t => {
  const { directory, hostId } = await fixture(t);
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  let handle: ((request: Request) => Promise<Response>) | undefined;
  let live: { header: { cwd: string } } | undefined;
  let changeDuringCheck = false;
  const checked: (string | undefined)[] = [];
  t.mock.method(WorkspaceAccess.prototype, 'resolve', async (cwd?: string) => {
    checked.push(cwd);
    if (changeDuringCheck) live = { header: { cwd: '/different-workspace' } };
    return { hostIds: [hostId], cwd: '/srv/remote' };
  });
  ctx.provide('connection', { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) { if (route.path === '/api/remote-agents') handle = route.fetch; } } });
  ctx.provide('sessions', { get: () => live });
  ctx.provide('sessionPersistence', { list: async () => [{ header: { id: 'cold-session', cwd: '/saved/workspace' } }] });
  const mounted = ctx.plugin(plugin, { stateDir: directory }); await mounted.await();
  const request = () => handle!(new Request('http://dsh.test/api/remote-agents', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' },
    body: JSON.stringify({ action: 'workspaceModels', sessionId: 'cold-session', cwd: '/untrusted-client-path' }),
  }));
  assert.deepEqual(await (await request()).json(), { hostIds: [hostId], cwd: '/srv/remote' });
  assert.equal(checked.at(-1), '/saved/workspace');
  live = { header: { cwd: '/live/workspace' } };
  await request(); assert.equal(checked.at(-1), '/live/workspace');
  changeDuringCheck = true;
  assert.deepEqual(await (await request()).json(), { hostIds: [] });
});
