import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitView } from '../src/git.js';
import type { RemoteWorkspaces } from '../src/runner.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const actions = {
  pull: (view: GitView, id: string, signal: AbortSignal) => view.pull('session', id, signal),
  sync: (view: GitView, id: string, signal: AbortSignal) => view.sync('session', id, signal),
  saveResolve: (view: GitView, id: string, signal: AbortSignal) => view.saveResolve('session', 'file.txt', 'resolved\n', 'a'.repeat(64), id, signal),
};

for (const [name, invoke] of Object.entries(actions)) {
  test(`${name}: cancel during local workspace discovery prevents every Git/file mutation`, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'git-early-cancel-')));
    t.after(async () => { assert.match(root, /\/git-early-cancel-[^/]+$/); await rm(root, { recursive: true, force: true }); });
    const entered = deferred<void>(), cwd = deferred<string>(); let runs = 0;
    const view = new GitView({ cwdOf: async () => { entered.resolve(); return cwd.promise; }, remote: () => undefined,
      local: () => ({ run: async () => { runs++; throw new Error('Git must not run'); }, cancel: async () => {} }) });
    const id = randomUUID(), pending = invoke(view, id, new AbortController().signal);
    await entered.promise;
    await view.cancel(id);
    cwd.resolve(root);
    await assert.rejects(pending, /The Git operation was cancelled/);
    assert.equal(runs, 0);
  });

  test(`${name}: cancel during SSH target discovery reaches its signal and prevents transfer/Git`, async () => {
    const entered = deferred<void>(), target = deferred<{ hostId: string; label: string; cwd: string }>();
    let signal: AbortSignal | undefined, calls = 0;
    const forbidden = async () => { calls++; throw new Error('No remote I/O after cancellation'); };
    const remote = { gitWorkspaceVersion: 1, target: async (_session: string, current: AbortSignal) => {
      signal = current; entered.resolve(); return target.promise;
    }, git: forbidden, cancelGit: async () => {}, stat: forbidden, download: forbidden, upload: forbidden } as unknown as RemoteWorkspaces;
    const view = new GitView({ cwdOf: async () => '/synthetic/remote-workspaces/host/repo', isRemoteCwd: () => true,
      remote: () => remote, local: () => { throw new Error('No local fallback'); } });
    const id = randomUUID(), pending = invoke(view, id, new AbortController().signal);
    await entered.promise;
    await view.cancel(id);
    assert.equal(signal?.aborted, true);
    target.resolve({ hostId: 'host', label: 'SSH', cwd: '/repo' });
    await assert.rejects(pending, /The Git operation was cancelled/);
    assert.equal(calls, 0);
  });
}

test('duplicate mutation IDs are refused while the original is still discovering its workspace', async () => {
  const entered = deferred<void>(), cwd = deferred<string>();
  const view = new GitView({ cwdOf: async () => { entered.resolve(); return cwd.promise; }, remote: () => undefined,
    local: () => { throw new Error('No Git runner required'); } });
  const id = randomUUID(), signal = new AbortController().signal, first = view.pull('session', id, signal);
  await entered.promise;
  await assert.rejects(view.push('session', id, signal), /already running/);
  await view.cancel(id);
  cwd.resolve('/nonexistent-workspace-cancelled-before-use');
  await assert.rejects(first, /The Git operation was cancelled/);
});
