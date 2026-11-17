import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/index.js';
import { Store, localMachineLabel } from '../src/core/store.js';
import { RemoteAgentsService } from '../src/agents/service.js';
import { SshBackend } from '../src/agents/backend.js';
import { WorkspaceAccess } from '@dsh-plugins/remote-core/access.js';
import { LocalShellTransport, loginEnvironment, type SshTransport } from '@dsh-plugins/remote-core/ssh.js';
import { LOCAL_CONNECTION, LOCAL_HOST_ID, LOCAL_SERVER_ID, type Provider } from '@dsh-plugins/remote-core/domain.js';
import type { RemoteAgentsMachines } from '@dsh-plugins/remote-core/machines.js';
import { fixture } from './fakes.js';

async function scratch(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'ra-local-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('every DSH has this computer as a machine, added once and saved with the next change', async t => {
  const directory = await scratch(t), path = join(directory, 'state.json');
  const store = new Store(path, { localMachine: true }); await store.open();
  assert.deepEqual(store.hosts(), [{ id: LOCAL_HOST_ID, label: localMachineLabel(), connection: LOCAL_CONNECTION }]);
  await assert.rejects(readFile(path), { code: 'ENOENT' }, 'opening writes nothing');
  await store.update(state => { state.chatFast = ['s']; });
  const saved = JSON.parse(await readFile(path, 'utf8')) as { hosts: { id: string }[] };
  assert.deepEqual(saved.hosts.map(h => h.id), [LOCAL_HOST_ID]);
  const again = new Store(path, { localMachine: true }); await again.open();
  assert.equal(again.hosts().length, 1, 'never added twice');
  assert.equal(new Store(join(directory, 'other.json')).hosts().length, 0, 'only when asked for');
  assert.equal(localMachineLabel('lalaze-mini.local'), 'lalaze-mini');
  assert.equal(localMachineLabel('build.example.com'), 'build.example.com');
  assert.equal(localMachineLabel(''), 'This computer');
});

test('this computer cannot be removed; an SSH machine still can', async t => {
  const directory = await scratch(t);
  const store = new Store(join(directory, 'state.json'), { localMachine: true }); await store.open();
  const service = new RemoteAgentsService(store, () => { throw new Error('no connection expected'); });
  t.after(() => service.close());
  await assert.rejects(service.removeHost(LOCAL_HOST_ID), /cannot be removed/);
  assert.equal((await service.snapshot()).hosts[0].status, 'connected', 'this computer needs no connection');
  const { hosts } = await service.addHost({ label: 'Build', connection: 'ssh://dev@build' });
  const added = hosts.find(h => h.id !== LOCAL_HOST_ID)!;
  assert.deepEqual((await service.removeHost(added.id)).hosts.map(h => h.id), [LOCAL_HOST_ID]);
});

test('a folder on this computer runs CLIs here; everything else about it stays local', async t => {
  const { directory, store } = await fixture(t);
  await store.update(state => { state.hosts.push({ id: LOCAL_HOST_ID, label: 'mini', connection: LOCAL_CONNECTION }); });
  const folder = join(directory, 'project'); await mkdir(folder);
  const canonical = await realpath(folder);
  let output = [hostname(), userInfo().username, 'Darwin', canonical, ''].join('\0');
  const runtime = () => ({
    spawn() {
      const stdout = new PassThrough(), stderr = new PassThrough();
      const done = new Promise<{ exitCode: number }>(resolve => queueMicrotask(() => { stdout.end(output); stderr.end(); resolve({ exitCode: 0 }); }));
      return { stdout, stderr, done, terminate() { stdout.destroy(); stderr.destroy(); } };
    },
  });
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'), runtime });
  assert.deepEqual(await access.resolve(folder), { hostIds: [] }, 'Git, files and terminals of a local folder stay DSH’s own');
  assert.deepEqual(await access.resolveForCli(folder), { hostIds: [LOCAL_HOST_ID], cwd: canonical });
  // A folder DSH runs on another machine is placed as before.
  output = ['remote-machine', 'builder', 'unique', '/srv/app', ''].join('\0');
  assert.deepEqual(await access.resolveForCli(folder), { hostIds: [], cwd: '/srv/app' });
  // Without DSH's process service, an existing folder is on this computer and a missing one is nowhere.
  const bare = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc') });
  assert.deepEqual(await bare.resolveForCli(folder), { hostIds: [LOCAL_HOST_ID], cwd: canonical });
  assert.deepEqual(await bare.resolveForCli(join(directory, 'missing')), { hostIds: [] });
  assert.deepEqual(await bare.resolve(folder), { hostIds: [] });
});

test('the local shell starts from a login environment, without DSH’s own variables', async t => {
  const env = loginEnvironment({ ELECTRON_RUN_AS_NODE: '1', DSH_HOME: '/x', HTTPS_PROXY: 'http://proxy', LANG: 'zh_CN.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp/me/', PATH: '/dsh/bin' },
    { homedir: '/Users/me', username: 'me', shell: '/bin/zsh', uid: 1, gid: 1 });
  assert.deepEqual(env, { HOME: '/Users/me', USER: 'me', LOGNAME: 'me', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'zh_CN.UTF-8', LC_ALL: 'C', TMPDIR: '/tmp/me/' });
  process.env.DSH_LOCAL_MACHINE_LEAK = 'leaked';
  t.after(() => { delete process.env.DSH_LOCAL_MACHINE_LEAK; });
  const output = await new LocalShellTransport().exec('printf \'%s|%s|%s\' "$HOME" "$(pwd)" "${DSH_LOCAL_MACHINE_LEAK-unset}"', 20_000, { login: false });
  assert.equal(output, `${homedir()}|${await realpath(homedir())}|unset`);
});

test('this computer needs no connection check: its identity is fixed', async t => {
  const directory = await scratch(t);
  const store = new Store(join(directory, 'state.json')); await store.open();
  const refuse = () => { throw new Error('no command expected'); };
  const transport: SshTransport = { exec: refuse, start: refuse };
  const backend = new SshBackend({ id: LOCAL_HOST_ID, label: 'mini', connection: LOCAL_CONNECTION }, store, transport);
  t.after(() => backend.close());
  assert.equal(await backend.connect(), LOCAL_SERVER_ID);
});

test('the picker offers this computer’s CLIs in its folders, detecting them on first use; other plugins never see it', async t => {
  const directory = await scratch(t), folder = join(directory, 'project'); await mkdir(folder);
  const ready: Provider = { id: 'claude', label: 'Claude Code', status: 'ready', models: [{ id: 'opus', label: 'Opus' }], modes: [] } as Provider;
  const providers = t.mock.method(SshBackend.prototype, 'providers', async () => [ready]);
  t.mock.method(SshBackend.prototype, 'homeDirectory', async () => '/Users/me');
  t.mock.method(SshBackend.prototype, 'cleanup', async () => {});
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  let handle: ((request: Request) => Promise<Response>) | undefined;
  ctx.provide('connection', { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) { if (route.path === '/api/remote-agents') handle = route.fetch; } } });
  ctx.provide('sessions', { get: () => ({ header: { cwd: folder } }) });
  const mounted = ctx.plugin(plugin, { stateDir: directory }); await mounted.await();
  const api = async (body: Record<string, unknown>) => (await handle!(new Request('http://dsh.test/api/remote-agents', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }))).json();
  assert.equal(providers.mock.callCount(), 0, 'starting DSH detects nothing');
  assert.deepEqual(await api({ action: 'workspaceModels', sessionId: 'local-session' }), { hostIds: [LOCAL_HOST_ID], cwd: await realpath(folder) });
  for (let i = 0; i < 100 && !(await api({ action: 'hostCatalogs' }) as unknown[]).length; i++) await pause(20);
  assert.deepEqual((await api({ action: 'hostCatalogs' }) as { hostId: string; providers: Provider[] }[]).map(p => [p.hostId, p.providers.map(x => x.id)]), [[LOCAL_HOST_ID, ['claude']]]);
  await api({ action: 'workspaceModels', sessionId: 'local-session' });
  assert.equal(providers.mock.callCount(), 1, 'detected once');
  const machines = ctx.get('remoteAgentsMachines' as never) as unknown as RemoteAgentsMachines;
  assert.deepEqual(machines.hosts(), []);
  await assert.rejects(machines.browse(LOCAL_HOST_ID), /not a remote machine/);
  // A TUI conversation works on this computer through its CLI target, and runs its commands here.
  await assert.rejects(machines.target('local-session'), /verified remote workspace/);
  const target = await machines.cliTarget!('local-session');
  assert.deepEqual(target, { hostId: LOCAL_HOST_ID, label: localMachineLabel(), cwd: await realpath(folder) });
  const here = await machines.withWorkspace(target.hostId, async () => { await machines.cliTarget!('local-session', undefined, target); },
    files => files.transport.exec(`cd ${JSON.stringify(target.cwd)} && pwd -P`, 20_000, { login: false }));
  assert.equal(here.trim(), target.cwd);
  assert.deepEqual(await machines.resolve(folder), { hostIds: [] });
  assert.match(JSON.stringify(await api({ action: 'createWorkspace', hostId: LOCAL_HOST_ID, path: folder })), /This computer/);
});
