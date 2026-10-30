import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authFailure, parseBranches, parseLog, parseStatus, parseTrack, repoName } from '../src/parse.js';

const F = '\x1f', R = '\x1e';
test('branches: local and remote, current first, tracking counts, and a remote HEAD left out', () => {
  const ref = (refname: string, sha: string, subject: string, upstream = '', track = '', symref = '') =>
    [refname, sha, sha.slice(0, 7), '2026-10-30 10:00:00 +0800', subject, upstream, track, symref].join(F) + R + '\n';
  const text = ref('refs/heads/topic', 'b'.repeat(40), 'Topic\twork') + ref('refs/heads/main', 'a'.repeat(40), 'Main', 'origin/main', '[ahead 2, behind 1]')
    + ref('refs/heads/old', 'c'.repeat(40), 'Old', 'origin/old', '[gone]') + ref('refs/remotes/origin/HEAD', 'a'.repeat(40), 'Main', '', '', 'refs/remotes/origin/main')
    + ref('refs/remotes/origin/main', 'd'.repeat(40), 'Remote main');
  const view = parseBranches(text, 'main');
  assert.deepEqual(view.local.map(b => [b.name, b.current, b.ahead, b.behind, b.gone]), [['main', true, 2, 1, undefined], ['old', false, undefined, undefined, true], ['topic', false, undefined, undefined, undefined]]);
  assert.equal(view.local[2].subject, 'Topic work');
  assert.deepEqual(view.remote.map(b => b.name), ['origin/main']);
  assert.equal(view.tips['origin/main'], 'd'.repeat(40));
  assert.equal(view.tips['origin/HEAD'], undefined);
  assert.deepEqual(parseTrack('[behind 3]'), { behind: 3 });
  assert.deepEqual(parseTrack(''), {});
});
test('the log keeps parents and drops repeated commits', () => {
  const commit = (sha: string, parents: string, subject: string) => [sha, parents, 'Ana', '2026-10-30 10:00:00 +0800', subject].join(F) + R;
  const commits = parseLog([commit('3', '1 2', 'Merge'), commit('2', '1', 'Side'), commit('2', '1', 'Side'), commit('1', '', 'Root')].join('\n'));
  assert.deepEqual(commits.map(c => [c.sha, c.parents]), [['3', ['1', '2']], ['2', ['1']], ['1', []]]);
});
test('status entries keep their codes, renames their original path, and map into the workspace folder', () => {
  const text = [' M app/src/a.ts', '?? app/new file.txt', 'R  app/b.ts', 'app/old b.ts', 'UU lib/c.ts', 'MM app/'].join('\0') + '\0';
  assert.deepEqual(parseStatus(text, 'app/'), [
    { code: 'MM', path: 'app/' },
    { code: 'R ', path: 'app/b.ts', from: 'app/old b.ts', local: 'b.ts' },
    { code: '??', path: 'app/new file.txt', local: 'new file.txt' },
    { code: ' M', path: 'app/src/a.ts', local: 'src/a.ts' },
    { code: 'UU', path: 'lib/c.ts' },
  ]);
  assert.deepEqual(parseStatus(' M a.ts\0', '').map(c => c.local), ['a.ts']);
});
test('repository names and sign-in failures', () => {
  assert.equal(repoName('/home/me/project\n'), 'project');
  assert.equal(repoName('C:/work/app'), 'app');
  assert.equal(authFailure("fatal: could not read Username for 'https://example.com': terminal prompts disabled"), 'https');
  assert.equal(authFailure('remote: HTTP Basic: Access denied\nfatal: Authentication failed for ...'), 'https');
  assert.equal(authFailure('git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'), 'ssh');
  assert.equal(authFailure('error: failed to push some refs'), undefined);
});
