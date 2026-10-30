import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitView } from '../src/git.js';

test('unstaging a rename resets both literal paths and keeps both worktree changes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-view-rename-')));
  t.after(async () => { assert.match(root, /\/git-view-rename-[^/]+$/); await rm(root, { recursive: true, force: true }); });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'old [1].txt'), 'old\n'); await writeFile(join(root, 'untouched.txt'), 'stay\n');
  git('add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial');
  git('mv', '--', 'old [1].txt', 'new *.txt');
  const view = new GitView({ cwdOf: async () => root, remote: () => undefined, local: () => ({
    cancel: async () => {},
    run: async batch => batch.commands.map(command => ({ stdout: git(...command.argv), stderr: '', exitCode: 0, timedOut: false, truncated: false, skipped: false })),
  }) });
  await view.unstage('s', 'new *.txt', undefined, new AbortController().signal, 'old [1].txt');
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.deepEqual(git('status', '--porcelain', '-z').split('\0').filter(Boolean), [' D old [1].txt', '?? new *.txt']);
});
