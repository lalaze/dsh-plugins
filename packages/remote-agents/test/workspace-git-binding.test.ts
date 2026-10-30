import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RemoteError } from '../src/core/domain.js';
import type { WorkspacePlacement } from '../src/workspace/access.js';
import type { GitBatch, GitRun, WorkspaceTarget } from '../src/workspace/domain.js';
import type { WorkspaceFiles } from '../src/workspace/files.js';
import type { WorkspaceHosts } from '../src/workspace/hosts.js';
import { WorkspaceService } from '../src/workspace/service.js';

const signal = new AbortController().signal;
const a: WorkspaceTarget = { hostId: 'a', label: 'A', cwd: '/srv/a' };
const b: WorkspaceTarget = { hostId: 'b', label: 'B', cwd: '/srv/b' };
const batch = (): GitBatch => ({ id: randomUUID(), commands: [{ argv: ['status'], timeoutMs: 1000 }], maxBytes: 1024 });
const ok: GitRun[] = [{ exitCode: 0, stdout: '', stderr: '', skipped: false, timedOut: false, truncated: false }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const state = { target: a, beforeVerify: async () => {}, beforePlacement: async () => {}, identityValid: true,
    git: async (): Promise<GitRun[]> => ok };
  const calls: { action: string; host: string; cwd?: string; id?: string }[] = [];
  const machines = {
    hosts: () => [a, b].map(t => ({ id: t.hostId, label: t.label })),
    async withWorkspace<T>(host: string, verify: () => Promise<void>, action: (files: WorkspaceFiles) => Promise<T>): Promise<T> {
      calls.push({ action: 'connection', host });
      if (!state.identityValid) throw new RemoteError('Remote SSH machine identity changed', 409);
      await state.beforeVerify(); await verify();
      const files = {
        git: async (cwd: string, request: GitBatch) => { calls.push({ action: 'git', host, cwd, id: request.id }); return state.git(); },
        cancelGit: async (cwd: string, id: string) => { calls.push({ action: 'cancel', host, cwd, id }); },
        operate: async (cwd: string) => { calls.push({ action: 'stat', host, cwd }); return {}; },
        download: async (cwd: string) => { calls.push({ action: 'download', host, cwd }); return Buffer.from('same'); },
        upload: async (cwd: string) => { calls.push({ action: 'upload', host, cwd }); return {}; },
      } as unknown as WorkspaceFiles;
      return action(files);
    },
  } as unknown as WorkspaceHosts;
  const service = new WorkspaceService(machines, async (): Promise<WorkspacePlacement> => {
    await state.beforePlacement();
    return { hostIds: [state.target.hostId], cwd: state.target.cwd };
  }, async () => '/local-anchor');
  return { service, state, calls };
}
const conflict = (error: unknown) => error instanceof RemoteError && error.status === 409;
const operations = (service: WorkspaceService) => [
  () => service.git('s', batch(), signal, a),
  () => service.operate('s', { op: 'stat', path: 'same.txt' }, signal, a),
  () => service.download('s', 'same.txt', 'a'.repeat(64), signal, a),
  () => service.upload('s', 'same.txt', 'a'.repeat(64), 4, (async function* () { yield Buffer.from('same'); })(), signal, a),
];

test('Git and file calls reject an expected target changed before dispatch, including the same host', async () => {
  for (const target of [b, { ...a, cwd: '/srv/other' }]) {
    const { service, state, calls } = fixture();
    state.target = target;
    for (const operation of operations(service)) await assert.rejects(operation(), conflict);
    assert.deepEqual(calls, [], 'do not open a connection or read/write identical files in the replacement workspace');
  }
});

test('Git and file calls recheck their pinned target after SSH connection discovery', async () => {
  for (let index = 0; index < 4; index++) {
    const { service, state, calls } = fixture();
    state.beforeVerify = async () => { state.target = b; };
    await assert.rejects(operations(service)[index](), conflict);
    assert.deepEqual(calls, [{ action: 'connection', host: 'a' }], 'no Git or file operation reaches either workspace');
  }
});

test('cancellation follows only the original active session/job after retargeting, with connection identity checks', async () => {
  const { service, state, calls } = fixture(), request = batch(), started = deferred<void>(), done = deferred<GitRun[]>();
  state.git = () => { started.resolve(); return done.promise; };
  const running = service.git('owner', request, signal, a);
  await started.promise;
  await assert.rejects(service.git('owner', request, signal, a), /already running/);
  state.target = b;
  const count = calls.length;
  await service.cancelGit('another-session', request.id, signal, a);
  assert.equal(calls.length, count, 'a different session cannot cancel the job');
  await assert.rejects(service.cancelGit('owner', request.id, signal, b), conflict);
  assert.equal(calls.length, count, 'a caller cannot redirect cancellation with a different expected target');
  state.identityValid = false;
  await assert.rejects(service.cancelGit('owner', request.id, signal, a), /machine identity changed/);
  assert.equal(calls.some(c => c.action === 'cancel'), false);
  state.identityValid = true;
  await service.cancelGit('owner', request.id, signal, a);
  assert.deepEqual(calls.at(-1), { action: 'cancel', host: 'a', cwd: '/srv/a', id: request.id });
  done.resolve(ok); await running;
  const completed = calls.length;
  await service.cancelGit('owner', request.id, signal, a);
  assert.equal(calls.length, completed, 'completed jobs cannot reopen a connection or cancel unrelated work');
});

test('cancellation during placement discovery prevents Git from starting', async () => {
  const { service, state, calls } = fixture(), request = batch(), entered = deferred<void>(), release = deferred<void>();
  state.beforePlacement = async () => { entered.resolve(); await release.promise; };
  const running = service.git('s', request, signal, a);
  const rejected = assert.rejects(running, /Git operation was cancelled/);
  await entered.promise;
  await service.cancelGit('s', request.id, signal, a);
  release.resolve(); await rejected;
  assert.deepEqual(calls, []);
  state.beforePlacement = async () => {};
  assert.deepEqual(await service.git('s', request, signal, a), ok, 'cleanup allows a later request with the same ID');
});

test('cancellation during connection discovery prevents the pending Git action', async () => {
  const { service, state, calls } = fixture(), request = batch(), entered = deferred<void>(), release = deferred<void>();
  state.beforeVerify = async () => { entered.resolve(); await release.promise; };
  const running = service.git('s', request, signal, a);
  const rejected = assert.rejects(running, /Git operation was cancelled/);
  await entered.promise;
  await service.cancelGit('s', request.id, signal, a);
  release.resolve(); await rejected;
  assert.deepEqual(calls, [{ action: 'connection', host: 'a' }]);
});

test('failed Git calls remove their active cancellation binding', async () => {
  const { service, state, calls } = fixture(), request = batch();
  state.git = async () => { throw new RemoteError('Git failed', 422); };
  await assert.rejects(service.git('s', request, signal, a), /Git failed/);
  state.target = b;
  const count = calls.length;
  await service.cancelGit('s', request.id, signal, a);
  assert.equal(calls.length, count);
});
