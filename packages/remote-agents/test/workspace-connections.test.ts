import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
import { fixture } from './fakes.js';
import { WorkspaceTunnels, tunnelArguments } from '../src/workspace-tunnels.js';
import { installWorkspaceTerminal } from '../src/workspace-terminal.js';
import { ensureAnchor } from '../src/remote-workspaces.js';
import { workspaceAction, type WorkspaceFeatures } from '../src/workspace-http.js';

test('tunnel startup, stop, saved definitions and host removal are independent of remote agents', async t => {
  const f = await fixture(t), path = join(f.directory, 'tunnels.json'); let args: string[] = [];
  const manager = new WorkspaceTunnels(path, () => f.store.hosts(), values => {
    args = values;
    return spawn(process.execPath, ['-e', 'process.stderr.write("debug1: Entering interactive session.\\n");setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  });
  t.after(() => manager.close()); await manager.open();
  const config = { id: 'tunnel-test-1', hostId: f.hostId, direction: 'local', listenPort: 38081, targetPort: 3000, targetHost: '127.0.0.1' };
  await manager.add(config); const running = await manager.start(config.id, f.hostId);
  assert.equal(running.status, 'running'); assert.ok(args.includes('0.0.0.0:38081:127.0.0.1:3000')); assert.ok(args.includes('StrictHostKeyChecking=yes'));
  await assert.rejects(manager.add({ ...config, id: 'tunnel-other' }), /already saved/);
  assert.throws(() => manager.stop(config.id, 'other-host'), /not found/);
  manager.stop(config.id, f.hostId); assert.equal(manager.list(f.hostId)[0].status, 'stopped');
  const restarted = new WorkspaceTunnels(path, () => f.store.hosts()); await restarted.open(); t.after(() => restarted.close());
  assert.equal(restarted.list(f.hostId)[0].status, 'stopped');
  await manager.start(config.id, f.hostId); await manager.removeHost(f.hostId); assert.deepEqual(manager.list(f.hostId), []);
  assert.equal(f.remote.stops, 0); assert.equal(f.remote.closes, 0);
  const reverse = tunnelArguments('ssh://jump-alias', { ...running, direction: 'reverse' });
  assert.ok(reverse.includes('-R')); assert.ok(reverse.includes('127.0.0.1:38081:127.0.0.1:3000')); assert.equal(reverse.at(-1), 'jump-alias');
});

test('native terminal launcher resolves the workspace, refuses an invalid binding and opens the local shell elsewhere', async t => {
  if (process.platform === 'win32') { t.skip('POSIX terminal launcher test'); return; }
  const f = await fixture(t), modules = join(f.directory, 'modules'), bin = join(f.directory, 'bin'), capture = join(f.directory, 'ssh-args.json');
  await mkdir(modules); await mkdir(bin); await writeFile(join(modules, 'package.json'), '{"type":"module"}');
  for (const name of ['domain', 'store', 'ssh', 'workspace-access']) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    await writeFile(join(modules, `${name}.js`), (await transform(source, { loader: 'ts', format: 'esm', target: 'node22' })).code);
  }
  await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('-G'))process.stdout.write('hostname build-box\\nuser builder\\nport 22\\n');else fs.writeFileSync(process.env.DSH_TERMINAL_CAPTURE,JSON.stringify(process.argv.slice(2)));\n`); await chmod(join(bin, 'ssh'), 0o700);
  const anchor = await ensureAnchor(f.directory, { host: 'build-box', username: 'builder', port: 22 }, '/srv/app');
  const controller = { config: { shellCandidates: ['/bin/sh'] } };
  const { shell: launcher, dispose: cleanup } = await installWorkspaceTerminal(controller, join(f.directory, 'terminal'), f.path, pathToFileURL(modules + '/')); t.after(cleanup);
  assert.ok(launcher); assert.equal(controller.config.shellCandidates[1], launcher);
  const env = { ...process.env, DSH_HOME: f.directory, DSH_TERMINAL_CAPTURE: capture, PATH: `${bin}:${process.env.PATH}` };
  await promisify(execFile)(launcher, [], { cwd: anchor, env });
  const args: string[] = JSON.parse(await readFile(capture, 'utf8'));
  assert.ok(args.includes('-tt')); assert.ok(args.includes('builder@build-box')); assert.equal(args.at(-1), 'cd \'/srv/app\' && exec "${SHELL:-/bin/sh}" -l');
  await writeFile(join(anchor, '.dsh-remote-meta.json'), '{}');
  await assert.rejects(promisify(execFile)(launcher, [], { cwd: anchor, env }), /valid remote workspace binding/);
  const omc = join(f.directory, 'omc'), placeholder = join(omc, 'remote-workspaces', 'removed'); await mkdir(placeholder, { recursive: true });
  await assert.rejects(promisify(execFile)(launcher, [], { cwd: placeholder, env: { ...env, DSH_OMC_STATE_DIR: omc } }), /verified remote workspace/);
  // The DSH-wide remembered shell also opens local conversations, which get the local shell instead of SSH.
  const local = join(f.directory, 'project'), shell = join(bin, 'local-shell'); await mkdir(local);
  await writeFile(shell, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.DSH_TERMINAL_CAPTURE,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),electron:process.env.ELECTRON_RUN_AS_NODE??null}));\n`); await chmod(shell, 0o700);
  const { stderr } = await promisify(execFile)(launcher, [], { cwd: local, env: { ...env, SHELL: shell, DSH_OMC_STATE_DIR: omc } });
  assert.match(stderr, /Not a remote workspace/);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), { args: ['-i'], cwd: local, electron: null });
  cleanup(); assert.deepEqual(controller.config.shellCandidates, ['/bin/sh']);
});

test('the workspace target names the Remote workspace shell once it is installed', async () => {
  const terminal: { shell?: string } = {}, signal = new AbortController().signal;
  const features = { files: { target: async () => ({ hostId: 'host-test', label: 'Box', cwd: '/srv/app' }) }, terminal } as unknown as WorkspaceFeatures;
  assert.deepEqual(await workspaceAction(features, 'workspaceTarget', { sessionId: 'session' }, signal), { hostId: 'host-test', label: 'Box', cwd: '/srv/app' });
  terminal.shell = '/dsh/terminal/Remote workspace';
  assert.deepEqual(await workspaceAction(features, 'workspaceTarget', { sessionId: 'session' }, signal), { hostId: 'host-test', label: 'Box', cwd: '/srv/app', terminalShell: '/dsh/terminal/Remote workspace' });
});
