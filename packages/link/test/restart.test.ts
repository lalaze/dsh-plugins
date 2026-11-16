import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { HelperJob, RestartRecord } from '../src/restart/state.js';
import { readRecord, writeRecord } from '../src/restart/state.js';
import { RestartService } from '../src/restart/service.js';
import { inspectBusy, restartTarget, versionChanges, type ProcessFacts } from '../src/restart/target.js';

const facts = (change: Partial<ProcessFacts>): ProcessFacts => ({
  platform: 'darwin', pid: 200, ppid: 100, uid: 501, execPath: '/usr/local/bin/node', execArgv: [], argv: ['/usr/local/bin/node', '/opt/dsh/lib/bin.js', 'web', '--port', '7412'],
  cwd: '/Users/me', env: { HOME: '/Users/me', NODE_CHANNEL_FD: '3' }, ipc: false, commandOf: () => undefined, launchctlPrint: () => undefined, ...change,
});

test('the hub: a launchd job whose pid is this process is kickstarted', () => {
  const target = restartTarget(facts({ env: { XPC_SERVICE_NAME: 'com.lalaze.dsh-mobile' }, launchctlPrint: name => name === 'gui/501/com.lalaze.dsh-mobile' ? '\tstate = running\n\tpid = 200\n' : undefined }));
  assert.deepEqual(target, { ok: true, launch: { kind: 'launchd', target: 'gui/501/com.lalaze.dsh-mobile' } });
  // A shell started by another job: DSH there is a plain process.
  const other = restartTarget(facts({ env: { XPC_SERVICE_NAME: 'com.example.agent' }, launchctlPrint: () => '\tpid = 999\n' }));
  assert.equal(other.ok && other.launch.kind, 'process');
});

test('the desktop app: quit the main process, open the bundle again', () => {
  const execPath = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
  const desktop = facts({ execPath, ipc: true, argv: [execPath, '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh-desktop-host.js'], env: { ELECTRON_RUN_AS_NODE: '1', XPC_SERVICE_NAME: 'application.ai.deepseek.harness.123' } });
  assert.deepEqual(restartTarget({ ...desktop, commandOf: pid => pid === 100 ? execPath : undefined }), { ok: true, launch: { kind: 'desktop', quitPid: 100, hostPid: 200, bundle: '/Applications/DeepSeek Harness.app' } });
  assert.match((restartTarget({ ...desktop, commandOf: () => `${execPath} --inspect` }) as { reason: string }).reason, /extra arguments/);
});

test('dsh web from a shell: the same command line again; systemd and Windows are refused', () => {
  const target = restartTarget(facts({ env: { XPC_SERVICE_NAME: '0', NODE_CHANNEL_FD: '3', PATH: '/bin' } }));
  assert.ok(target.ok && target.launch.kind === 'process');
  assert.deepEqual(target.ok && target.launch.kind === 'process' && [target.launch.command, target.launch.args, target.launch.env], ['/usr/local/bin/node', ['/opt/dsh/lib/bin.js', 'web', '--port', '7412'], { XPC_SERVICE_NAME: '0', PATH: '/bin' }]);
  assert.equal(restartTarget(facts({ platform: 'linux', env: { INVOCATION_ID: 'x' } })).ok, false);
  assert.equal(restartTarget(facts({ platform: 'win32' })).ok, false);
});

test('busy: running or queued turns and running jobs, each once', () => {
  const busy = inspectBusy(
    { list: () => [{ id: 'a', status: 'running', session: { id: 'a' } }, { id: 'b', status: 'idle', inbox: { nextTurn: [1] } }, { id: 'c', status: 'idle' }] },
    { list: owner => owner === undefined || owner === 'a' ? [{ id: 'j1', status: 'running', label: 'npm test' }, { id: 'j2', status: 'done' }] : [] },
    agent => agent.id === 'a' ? 'Fix the build' : undefined,
  );
  assert.deepEqual(busy, { sessions: [{ id: 'a', title: 'Fix the build' }, { id: 'b' }], jobs: [{ id: 'j1', label: 'npm test' }] });
});

test('what changed across a restart', () => {
  assert.deepEqual(versionChanges({ dsh: '0.2.2-rc.2', plugins: { a: '1', b: '1' } }, { dsh: '0.2.2-rc.3', plugins: { b: '2', c: '1' } }), [
    { name: 'dsh', from: '0.2.2-rc.2', to: '0.2.2-rc.3' }, { name: 'a', from: '1' }, { name: 'b', from: '1', to: '2' }, { name: 'c', to: '1' },
  ]);
});

test('an idle restart waits for running work, and can be cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-restart-'));
  let busy = true;
  const service = new RestartService({ dir, helper: '/nonexistent', target: () => ({ ok: false, reason: 'test' }), busy: () => busy ? { sessions: [{ id: 's' }], jobs: [] } : { sessions: [], jobs: [] }, versions: () => ({ plugins: {} }), warn: () => undefined });
  try {
    assert.throws(() => service.request('idle'), /test/);
    const ok = new RestartService({ dir, helper: '/nonexistent', target: () => ({ ok: true, launch: { kind: 'launchd', target: 'gui/1/x' } }), busy: () => busy ? { sessions: [{ id: 's' }], jobs: [] } : { sessions: [], jobs: [] }, versions: () => ({ plugins: {} }), warn: () => undefined });
    const record = ok.request('idle');
    assert.equal(record.phase, 'waiting');
    assert.equal(ok.request('idle').id, record.id, 'one restart at a time');
    assert.equal(ok.cancel()?.phase, 'cancelled');
    ok.dispose();
  } finally { service.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('the helper stops a DSH process, starts it again and sees the new one report back', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-helper-'));
  const fake = fileURLToPath(new URL('./fixtures/fake-host.mjs', import.meta.url));
  const helper = fileURLToPath(new URL('../src/restart/helper.ts', import.meta.url));
  const stateFile = join(dir, 'state.json');
  const old = spawn(process.execPath, [fake, stateFile], { stdio: 'ignore' });
  let toPid: number | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const record: RestartRecord = { id: 'r1', mode: 'now', phase: 'armed', requestedAt: Date.now(), fromPid: old.pid!, from: { plugins: {} }, log: join(dir, 'restart.log') };
    writeRecord(stateFile, record);
    const job: HelperJob = { id: 'r1', stateFile, launch: { kind: 'process', pid: old.pid!, command: process.execPath, args: [fake, stateFile], cwd: dir, env: { PATH: process.env.PATH ?? '' } }, startDelayMs: 100, quitTimeoutMs: 3_000, readyTimeoutMs: 5_000, attempts: 2, output: join(dir, 'dsh.out') };
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    const run = spawn(process.execPath, ['--import', 'tsx', helper, join(dir, 'job.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    run.stdout.on('data', data => { output += data; });
    run.stderr.on('data', data => { output += data; });
    const code = await new Promise<number | null>(resolve => run.on('exit', resolve));
    const final = readRecord(stateFile)!;
    toPid = final.toPid;
    assert.equal(code, 0, output);
    assert.equal(final.phase, 'back', output);
    assert.notEqual(final.toPid, old.pid);
    assert.equal(old.exitCode, 0, 'the old process quit on SIGTERM');
    assert.equal(final.attempts, 1);
    assert.match(output, /back: pid/);
  } finally {
    old.kill('SIGKILL');
    if (toPid) { try { process.kill(toPid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
