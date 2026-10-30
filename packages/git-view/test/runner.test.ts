import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRemoteAnchor, LocalRunner, RemoteRunner, type RemoteWorkspaces, type Subprocess } from '../src/runner.js';
import { RemoteFiles } from '../src/files.js';

const signal = new AbortController().signal;
test('cancelling during executable resolution skips every command', async () => {
  let resolve!: (value: string) => void;
  const git = new Promise<string>(done => { resolve = done; });
  const subprocess: Subprocess = { resolveExecutable: async () => 'git', spawn: () => assert.fail('cancelled request must never spawn') };
  const runner = new LocalRunner(subprocess, () => git, '/repo');
  const pending = runner.run({ id: 'test', commands: [{ argv: ['add', '-A'], timeoutMs: 1000 }, { argv: ['commit', '-m', 'test'], timeoutMs: 1000 }], maxBytes: 1000 }, signal);
  await runner.cancel('test'); resolve('git');
  assert.deepEqual((await pending).map(run => run.skipped), [true, true]);
});

test('remote Git and file requests carry the original verified target throughout', async () => {
  const target = { hostId: 'a', label: 'A', cwd: '/repo-a' }, seen: unknown[] = [];
  const service: RemoteWorkspaces = {
    gitWorkspaceVersion: 1,
    target: async () => target,
    git: async (_id, _batch, _signal, expected) => { seen.push(expected); return []; },
    cancelGit: async (_id, _job, _signal, expected) => { seen.push(expected); },
    stat: async (_id, path, _signal, expected) => { seen.push(expected); return { path, revision: 'a'.repeat(64), size: 4 }; },
    download: async (_id, _path, _rev, _signal, expected) => { seen.push(expected); return Buffer.from('text'); },
    upload: async (_id, path, revision, data, _signal, expected) => { seen.push(expected); return { path, revision: revision!, size: data.length }; },
  };
  const runner = new RemoteRunner(service, 's', target), files = new RemoteFiles(service, 's', target);
  await runner.run({ id: 'test', commands: [], maxBytes: 1000 }, signal);
  await runner.cancel('test'); await files.read('a.ts', signal); await files.write('a.ts', 'text', 'a'.repeat(64), signal);
  assert.deepEqual(seen, [target, target, target, target, target]);
});

test('remote routing uses the configured DSH home rather than any matching directory name', () => {
  assert.equal(isRemoteAnchor('/home/me/.dsh/remote-workspaces/host/repo', '/home/me/.dsh'), true);
  assert.equal(isRemoteAnchor('/custom/dsh/remote-workspaces/host/repo', '/custom/dsh'), true);
  assert.equal(isRemoteAnchor('/work/remote-workspaces/local-project', '/home/me/.dsh'), false);
  assert.equal(isRemoteAnchor('/home/me/.dsh/remote-workspaces-other/repo', '/home/me/.dsh'), false);
});

test('an unversioned remote Git implementation cannot silently ignore expected targets', () => {
  const legacy = { target: async () => ({hostId: 'h', label: 'H', cwd: '/repo'}),
    git: async () => [], cancelGit: async () => {}, stat: async () => ({}), download: async () => Buffer.alloc(0), upload: async () => ({}) } as unknown as RemoteWorkspaces;
  assert.throws(() => new RemoteRunner(legacy, 's'), /Update Remote Agents/);
  assert.throws(() => new RemoteRunner({ ...legacy, gitWorkspaceVersion: 0 }, 's'), /Update Remote Agents/);
});
