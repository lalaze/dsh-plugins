import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Credentials } from '../src/credentials.js';
import { GitView } from '../src/git.js';
import { createHandler } from '../src/http.js';
import { GitError, LocalRunner, type GitBatch, type RemoteWorkspaces, type Subprocess } from '../src/runner.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const signal = new AbortController().signal;
/** DSH's subprocess service, as far as the plugin uses it, over child_process; Git sees only the test's home. */
function subprocess(home: string): Subprocess {
  return {
    async resolveExecutable() { return 'git'; },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', ...spec.env } as NodeJS.ProcessEnv });
      let out = Buffer.alloc(0), err = '', lossy = false;
      child.stdout.on('data', (data: Buffer) => {
        out = Buffer.concat([out, data]);
        if (out.length > spec.stdio.stdout.maxBytes) { lossy = true; out = out.subarray(out.length - spec.stdio.stdout.maxBytes); }
      });
      child.stderr.on('data', data => { err += data; });
      const stop = () => child.kill('SIGTERM');
      spec.signal?.addEventListener('abort', stop, { once: true });
      const done = new Promise<{ exitCode: number | null }>((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ exitCode: code })); });
      return { done, collected: { stdout: { readFrom: () => ({ text: out.toString('utf8'), lossy }) }, stderr: { readFrom: () => ({ text: err }) } } };
    },
  };
}
const run = promisify(execFile);
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-git-view-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), origin = join(root, 'origin.git'), repo = join(root, 'repo');
  await mkdir(home);
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...argv: string[]) => run('git', argv, { cwd, env }).then(r => r.stdout);
  await git(root, 'init', '-q', '--bare', origin);
  await git(root, 'clone', '-q', origin, repo);
  await mkdir(join(repo, 'app'));
  await writeFile(join(repo, 'app/a.txt'), 'one\ntwo\n'); await writeFile(join(repo, 'top.txt'), 'top\n');
  await git(repo, 'add', '-A'); await git(repo, 'commit', '-q', '-m', 'Initial'); await git(repo, 'push', '-q', '-u', 'origin', 'main');
  const cwds: Record<string, string> = { app: join(repo, 'app'), root: repo, plain: root };
  const credentials = new Credentials(join(root, 'state/git-credentials')), process_ = subprocess(home);
  const commands: string[][] = [], spawn = process_.spawn;
  process_.spawn = spec => { commands.push([...spec.argv]); return spawn(spec); };
  const view = new GitView({ cwdOf: async id => cwds[id], local: cwd => new LocalRunner(process_, async () => 'git', cwd, () => credentials.config()), remote: () => undefined, credentials });
  return { root, repo, origin, home, git, view, cwds, credentials, commands };
}

test('the overview of a workspace folder inside a repository: branches, tracking, graph and changes mapped into the folder', async t => {
  const { repo, git, view } = await setup(t);
  await git(repo, 'switch', '-q', '-c', 'topic'); await writeFile(join(repo, 'top.txt'), 'top\nmore\n'); await git(repo, 'commit', '-qam', 'Topic change');
  await git(repo, 'push', '-q', 'origin', 'topic'); await git(repo, 'switch', '-q', 'main');
  await writeFile(join(repo, 'app/a.txt'), 'one\nchanged\n'); await git(repo, 'commit', '-qam', 'Ahead');
  await writeFile(join(repo, 'app/new [1] *.txt'), 'new\n'); await writeFile(join(repo, 'top.txt'), 'edited\n');
  const overview = await view.overview('app', signal);
  assert.deepEqual([overview.location, overview.repo, overview.current, overview.prefix], [{ kind: 'local' }, 'repo', 'main', 'app/']);
  assert.deepEqual(overview.local.map(b => [b.name, b.current, b.ahead ?? 0, b.upstream]), [['main', true, 1, 'origin/main'], ['topic', false, 0, undefined]]);
  assert.deepEqual(overview.remote.map(b => b.name), ['origin/main', 'origin/topic']);
  assert.deepEqual(overview.commits.map(c => c.subject), ['Ahead', 'Topic change', 'Initial']);
  assert.equal(overview.tips.main, overview.commits[0].sha);
  assert.deepEqual(overview.changes, [{ code: '??', path: 'app/new [1] *.txt', local: 'new [1] *.txt' }, { code: ' M', path: 'top.txt' }]);
  assert.deepEqual(await view.summary('app', signal), { location: { kind: 'local' }, repo: 'repo', current: 'main' });
  assert.deepEqual((await view.status('root', signal)).changes.map(c => c.local), ['app/new [1] *.txt', 'top.txt']);
});

test('changes are staged, unstaged, discarded and committed by their exact paths', async t => {
  const { repo, git, view } = await setup(t);
  // A literal pathspec: neither of these names may match the other.
  await writeFile(join(repo, '*.txt'), 'star\n'); await writeFile(join(repo, 'top.txt'), 'edited\n');
  await view.stage('root', '*.txt', randomUUID(), signal);
  assert.equal(await git(repo, 'diff', '--cached', '--name-only'), '*.txt\n');
  await view.unstage('root', '*.txt', randomUUID(), signal);
  assert.equal(await git(repo, 'diff', '--cached', '--name-only'), '');
  await view.discard('root', 'top.txt', false, randomUUID(), signal);
  assert.equal(await readFile(join(repo, 'top.txt'), 'utf8'), 'top\n');
  await view.discard('root', '*.txt', true, randomUUID(), signal);
  await assert.rejects(stat(join(repo, '*.txt')));
  await writeFile(join(repo, 'app/a.txt'), 'committed\n');
  const done = await view.commit('app', 'Message with "quotes" and $HOME', randomUUID(), signal);
  assert.match(done.output, /Message with "quotes" and \$HOME/);
  assert.equal(await git(repo, 'log', '-1', '--pretty=%s'), 'Message with "quotes" and $HOME\n');
  await assert.rejects(view.commit('app', '   ', randomUUID(), signal), /Invalid commit message/);
  await assert.rejects(view.stage('root', '../outside', randomUUID(), signal), /Invalid file path/);
});

test('branches switch, rename, merge, are deleted locally and remotely, and sync with their upstream', async t => {
  const { repo, origin, git, view } = await setup(t), id = () => randomUUID();
  await git(repo, 'switch', '-q', '-c', 'feature'); await writeFile(join(repo, 'feature.txt'), 'f\n'); await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'Feature');
  await git(repo, 'push', '-q', 'origin', 'feature'); await git(repo, 'switch', '-q', 'main'); await git(repo, 'branch', '-q', '-D', 'feature');
  await view.switchBranch('root', 'origin/feature', true, id(), signal);
  assert.equal((await view.summary('root', signal)).current, 'feature');
  await view.switchBranch('root', 'main', false, id(), signal);
  await view.merge('root', 'feature', id(), signal);
  assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'f\n');
  await view.rename('root', 'feature', 'renamed', id(), signal);
  await view.deleteBranch('root', 'renamed', id(), signal);
  assert.equal(await git(repo, 'branch', '--list', 'renamed'), '');
  await view.deleteRemoteBranch('root', 'origin/feature', id(), signal);
  assert.equal(await git(origin, 'branch', '--list', 'feature'), '');
  await view.push('root', id(), signal);
  // Another clone pushes; sync merges it without rewriting the local commit.
  const other = join(repo, '..', 'other');
  await git(join(repo, '..'), 'clone', '-q', origin, other); await writeFile(join(other, 'other.txt'), 'o\n'); await git(other, 'add', '-A'); await git(other, 'commit', '-qm', 'Other'); await git(other, 'push', '-q');
  await writeFile(join(repo, 'mine.txt'), 'm\n'); await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'Mine');
  const mine = await git(repo, 'rev-parse', 'HEAD');
  await view.fetch('root', id(), signal);
  assert.equal((await view.overview('root', signal)).local.find(b => b.current)?.behind, 1);
  await view.sync('root', id(), signal);
  assert.match(await git(origin, 'log', '-1', '--pretty=%s', 'main'), /Merge/);
  assert.equal((await git(origin, 'rev-list', '--parents', '-1', 'main')).trim().split(' ').length, 3);
  assert.equal(await git(repo, 'rev-parse', 'HEAD^1'), mine);
  await view.pull('root', id(), signal);
  for (const bad of ['-D', '', 'a\nb']) await assert.rejects(view.switchBranch('root', bad, false, id(), signal), /Invalid branch/);
  const failed = await view.switchBranch('root', 'missing', false, id(), signal).catch(error => error) as GitError;
  assert.equal(failed.status, 422); assert.match(failed.message, /missing/);
});

test('a merge conflict shows as unmerged; commits are cherry-picked and reverted; stashes are saved and restored', async t => {
  const { repo, git, view } = await setup(t), id = () => randomUUID();
  await git(repo, 'switch', '-q', '-c', 'side'); await writeFile(join(repo, 'top.txt'), 'side\n'); await git(repo, 'commit', '-qam', 'Side');
  await writeFile(join(repo, 'side.txt'), 'picked\n'); await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'Side file');
  const side = (await git(repo, 'rev-parse', 'HEAD')).trim();
  await git(repo, 'switch', '-q', 'main'); await writeFile(join(repo, 'top.txt'), 'main\n'); await git(repo, 'commit', '-qam', 'Main');
  await assert.rejects(view.merge('root', 'side', id(), signal), /CONFLICT|conflict/);
  assert.deepEqual((await view.status('root', signal)).changes, [{ code: 'A ', path: 'side.txt', local: 'side.txt' }, { code: 'UU', path: 'top.txt', local: 'top.txt' }]);
  await git(repo, 'merge', '--abort');
  await view.cherryPick('root', side.slice(0, 12), id(), signal);
  assert.equal(await readFile(join(repo, 'side.txt'), 'utf8'), 'picked\n');
  await writeFile(join(repo, 'app/a.txt'), 'pick\n'); await git(repo, 'commit', '-qam', 'To revert');
  await view.revert('root', (await git(repo, 'rev-parse', 'HEAD')).trim(), id(), signal);
  assert.equal(await readFile(join(repo, 'app/a.txt'), 'utf8'), 'one\ntwo\n');
  await assert.rejects(view.revert('root', 'HEAD', id(), signal), /Invalid commit/);
  await writeFile(join(repo, 'app/a.txt'), 'stashed\n');
  await view.stashPush('root', 'Work in progress', id(), signal);
  assert.equal(await readFile(join(repo, 'app/a.txt'), 'utf8'), 'one\ntwo\n');
  assert.match(await git(repo, 'stash', 'list'), /Work in progress/);
  await view.stashPop('root', id(), signal);
  assert.equal(await readFile(join(repo, 'app/a.txt'), 'utf8'), 'stashed\n');
});

test('a file is compared with HEAD and saved only over the version that was read', async t => {
  const { repo, view } = await setup(t);
  await writeFile(join(repo, 'app/a.txt'), 'one\nedited\n'); await writeFile(join(repo, 'app/new.txt'), 'fresh\n');
  await writeFile(join(repo, 'app/data.bin'), Buffer.from([0, 1, 2]));
  const compared = await view.compare('app', 'a.txt', signal);
  assert.deepEqual([compared.repoPath, compared.head, compared.code], ['app/a.txt', { kind: 'text', content: 'one\ntwo\n' }, ' M']);
  assert.deepEqual(compared.working, { kind: 'text', content: 'one\nedited\n', revision: sha('one\nedited\n'), size: 11 });
  assert.deepEqual([(await view.compare('app', 'new.txt', signal)).head, (await view.compare('app', 'new.txt', signal)).code], [{ kind: 'absent' }, '??']);
  assert.equal((await view.compare('app', 'data.bin', signal)).working.kind, 'binary');
  assert.deepEqual((await view.compare('app', 'gone.txt', signal)).working, { kind: 'missing' });
  await view.save('app', 'a.txt', 'resolved\n', sha('one\nedited\n'), signal);
  assert.equal(await readFile(join(repo, 'app/a.txt'), 'utf8'), 'resolved\n');
  await assert.rejects(view.save('app', 'a.txt', 'stale\n', sha('one\nedited\n'), signal), (error: GitError) => error.status === 409);
  await assert.rejects(view.compare('app', '../top.txt', signal), /Invalid file path/);
});

test('folders outside a repository, missing workspaces and remote workspaces without Remote Agents are reported', async t => {
  const { view, cwds, root } = await setup(t);
  const outside = await view.overview('plain', signal).catch(error => error) as GitError;
  assert.deepEqual([outside.status, outside.detail.code], [404, 'not-a-repo']);
  await assert.rejects(view.overview('unknown', signal), /no workspace folder/);
  cwds.anchor = join(root, '.dsh/remote-workspaces/host-user-22/app');
  await mkdir(cwds.anchor, { recursive: true });
  // The empty anchor folder never runs Git on this machine.
  await assert.rejects(view.overview('anchor', signal), /Install Remote Agents/);
});

test('remote workspaces run every Git request on their machine through Remote Agents', async t => {
  const { root } = await setup(t), anchor = join(root, '.dsh/remote-workspaces/host-user-22/app'), batches: GitBatch[] = [], cancelled: string[] = [];
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false, skipped: false });
  let verified = true;
  const service: RemoteWorkspaces = {
    gitWorkspaceVersion: 1,
    target: async () => { if (!verified) throw Object.assign(new Error('Select a verified remote workspace first.'), { status: 409 }); return { hostId: 'h', label: 'devbox', cwd: '/srv/app' }; },
    git: async (_id, batch) => { batches.push(batch); return batch.commands.map(c => ok(c.argv[0] === 'rev-parse' ? '/srv/app\n\n' : c.argv[0] === 'symbolic-ref' ? 'main\n' : '')); },
    cancelGit: async (_id, job) => { cancelled.push(job); },
    stat: async () => ({ path: 'a.txt', revision: sha('remote\n'), size: 7 }),
    download: async () => Buffer.from('remote\n'),
    upload: async (_s, path, revision, data) => { assert.equal(revision, sha('remote\n')); return { path, revision: createHash('sha256').update(data).digest('hex'), size: data.length }; },
  };
  const view = new GitView({ cwdOf: async () => anchor, local: () => { throw new Error('never local'); }, remote: () => service });
  const overview = await view.overview('s', signal);
  assert.deepEqual([overview.location, overview.repo, overview.current], [{ kind: 'remote', host: 'devbox', cwd: '/srv/app' }, 'app', 'main']);
  assert.equal(batches.length, 1, 'one round trip');
  assert.equal(batches[0].optionalLocks, false);
  assert.deepEqual((await view.compare('s', 'a.txt', signal)).working, { kind: 'text', content: 'remote\n', revision: sha('remote\n'), size: 7 });
  await view.save('s', 'a.txt', 'saved\n', sha('remote\n'), signal);
  await assert.rejects(view.saveCredential('s', 'example.com', 'me', 'secret', signal), /not saved for remote workspaces/);
  const id = randomUUID();
  await view.commit('s', 'Remote commit', id, signal);
  assert.deepEqual([batches.at(-1)!.id, batches.at(-1)!.stopOnError, batches.at(-1)!.commands.map(c => c.argv[0])], [id, true, ['add', 'commit']]);
  verified = false;
  const refused = await view.overview('s', signal).catch(error => error) as GitError;
  assert.deepEqual([refused.status, refused.message], [409, 'Select a verified remote workspace first.']);
  // A cancel reaches the machine the request runs on.
  let release = () => {};
  verified = true;
  service.git = async batch => { await new Promise<void>(resolve => { release = resolve; }); return [ok('')]; };
  const pending = view.push('s', id, signal);
  const rejected = assert.rejects(pending, (error: GitError) => error.detail.code === 'cancelled');
  await new Promise(resolve => setImmediate(resolve));
  await view.cancel(id); release(); await rejected;
  assert.deepEqual(cancelled, [id]);
});

test('a running local request is cancelled and its remaining commands are skipped', async t => {
  const { repo, home, credentials } = await setup(t), id = randomUUID();
  await writeFile(join(home, '.gitconfig'), '[alias]\n\twait = !sleep 30\n', { flag: 'a' });
  const view = new GitView({ cwdOf: async () => repo, local: cwd => new LocalRunner(subprocess(home), async () => 'git', cwd, () => credentials.config()), remote: () => undefined });
  const started = Date.now();
  // `git wait` stands in for a slow push.
  const pending = (view as unknown as { change(s: string, c: unknown[], id: string, signal: AbortSignal, fallback: string): Promise<unknown> })
    .change('x', [{ argv: ['wait'], timeoutMs: 60000 }, { argv: ['status'], timeoutMs: 20000 }], id, signal, 'failed');
  await new Promise(resolve => setTimeout(resolve, 300));
  await view.cancel(id);
  const error = await pending.catch(e => e) as GitError;
  assert.deepEqual([error.status, error.detail.code], [409, 'cancelled']);
  assert.ok(Date.now() - started < 10000);
  await view.cancel(randomUUID());
  await assert.rejects(view.cancel('../x'), /Invalid request ID/);
});

test('saved HTTPS credentials are private to this plugin and used for their host only', async t => {
  const { root, repo, git, view, credentials } = await setup(t);
  await git(repo, 'remote', 'set-url', 'origin', 'https://bob@git.example.com:8443/team/app.git');
  assert.deepEqual(await view.credentialTarget('root', signal), { host: 'git.example.com:8443', username: 'bob' });
  await view.saveCredential('root', 'git.example.com:8443', 'bob', 'p@ss word', signal);
  const file = join(root, 'state/git-credentials');
  assert.equal(await readFile(file, 'utf8'), 'https://bob:p%40ss%20word@git.example.com:8443\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await view.saveCredential('root', 'git.example.com:8443', 'carol', 'second', signal);
  assert.equal(await readFile(file, 'utf8'), 'https://carol:second@git.example.com:8443\n');
  const config = await credentials.config();
  assert.deepEqual(config, ['-c', 'credential.https://git.example.com:8443.helper=', '-c', `credential.https://git.example.com:8443.helper=store --file='${file}'`]);
  // Git itself reads the credential back through that helper chain.
  const fill = spawn('git', [...config, 'credential', 'fill'], { cwd: repo, env: { ...process.env, HOME: join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
  let filled = '';
  fill.stdout.on('data', data => { filled += data; });
  fill.stdin.end('protocol=https\nhost=git.example.com:8443\n\n');
  await new Promise(resolve => fill.on('close', resolve));
  assert.match(filled, /username=carol\npassword=second/);
  await assert.rejects(view.saveCredential('root', 'bad host', 'u', 'p', signal), /Invalid host/);
  await assert.rejects(view.saveCredential('root', 'example.com', 'u', 'line\nbreak', signal), /Invalid password/);
});

test('the route requires its client header and reports failures with their status and detail', async t => {
  const { view } = await setup(t), handler = createHandler(view);
  const post = (body: unknown, headers: Record<string, string> = { 'X-DSH-Git-View': '1' }) =>
    handler(new Request('http://dsh.test/api/git-view', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  assert.equal((await post({ action: 'overview', sessionId: 'root' }, {})).status, 403);
  const overview = await post({ action: 'overview', sessionId: 'root' });
  assert.equal(overview.status, 200); assert.equal((await overview.json()).current, 'main');
  const outside = await post({ action: 'summary', sessionId: 'plain' });
  assert.deepEqual([outside.status, await outside.json()], [404, { error: 'This folder is not a Git repository', code: 'not-a-repo' }]);
  assert.equal((await post({ action: 'nope', sessionId: 'root' })).status, 400);
  assert.equal((await post({ action: 'cancel', requestId: randomUUID() })).status, 200);
});


test('staged inline diffs show the index, not unstaged edits, including before the first commit', async t => {
  const { root, repo, git, view, cwds } = await setup(t);
  await writeFile(join(repo, 'top.txt'), 'staged value\n');
  await git(repo, 'add', 'top.txt');
  await writeFile(join(repo, 'top.txt'), 'top\n');
  assert.equal((await view.diff('root', 'top.txt', signal)).output, '', 'the working tree is back at HEAD');
  assert.match((await view.diff('root', 'top.txt', signal, true)).output, /\+staged value/);
  const compared = await view.compare('root', 'top.txt', signal);
  assert.deepEqual(compared.head, { kind: 'text', content: 'top\n' }, 'the full editor still compares HEAD to the working tree');
  assert.equal(compared.working.kind === 'text' && compared.working.content, 'top\n');
  const handler = createHandler(view);
  const response = await handler(new Request('http://dsh.test/api/git-view', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Git-View': '1' },
    body: JSON.stringify({ action: 'diff', sessionId: 'root', path: 'top.txt', staged: true }) }));
  assert.equal(response.status, 200);
  assert.match((await response.json()).output, /\+staged value/);
  const unborn = join(root, 'unborn');
  await mkdir(unborn); await git(unborn, 'init', '-q'); cwds.unborn = unborn;
  await writeFile(join(unborn, 'new.txt'), 'first file\n'); await git(unborn, 'add', 'new.txt');
  assert.match((await view.diff('unborn', 'new.txt', signal, true)).output, /\+first file/);
  await view.unstage('unborn', 'new.txt', randomUUID(), signal);
  assert.equal(await git(unborn, 'status', '--porcelain=v1'), '?? new.txt\n');
});

test('compare, save and stage reject a retargeted conversation even when file revisions match', async t => {
  const { root, repo, git, view, cwds } = await setup(t);
  const other = join(root, 'other-workspace');
  await git(root, 'clone', '-q', repo, other);
  cwds.moving = repo;
  const before = await view.compare('moving', 'top.txt', signal, repo);
  assert.equal(before.working.kind, 'text');
  cwds.moving = other;
  const revision = sha('top\n');
  assert.equal(await readFile(join(other, 'top.txt'), 'utf8'), 'top\n');
  const handler = createHandler(view);
  for (const action of ['compare', 'save', 'stage']) {
    const response = await handler(new Request('http://dsh.test/api/git-view', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Git-View': '1' },
      body: JSON.stringify({ action, sessionId: 'moving', path: 'top.txt', expectedCwd: repo, content: 'draft from old workspace\n', revision, requestId: randomUUID() }) }));
    assert.equal(response.status, 409, action);
    assert.equal((await response.json()).error, 'The workspace changed. Reopen the file before continuing.');
  }
  assert.equal(await readFile(join(other, 'top.txt'), 'utf8'), 'top\n');
  assert.equal(await git(other, 'diff', '--cached', '--name-only'), '');
  assert.equal((await view.compare('moving', 'top.txt', signal, other)).working.kind, 'text');
});

test('expected workspace is checked from one cwd lookup before either local or SSH access', async () => {
  for (const cwd of ['/local/b', '/home/me/.dsh/remote-workspaces/host/b']) {
    let reads = 0;
    const view = new GitView({ cwdOf: async () => { reads++; return cwd; },
      local: () => assert.fail('must not access local Git'), remote: () => assert.fail('must not access remote service') });
    await assert.rejects(view.compare('s', 'a.txt', signal, '/local/a'), (error: GitError) => error.status === 409);
    assert.equal(reads, 1);
    reads = 0;
    await assert.rejects(view.save('s', 'a.txt', 'draft', sha('old'), signal, '/local/a'), (error: GitError) => error.status === 409);
    assert.equal(reads, 1);
    reads = 0;
    await assert.rejects(view.stage('s', 'a.txt', randomUUID(), signal, '/local/a'), (error: GitError) => error.status === 409);
    assert.equal(reads, 1);
    reads = 0;
    await assert.rejects(view.saveResolve('s', 'a.txt', 'resolved', sha('old'), randomUUID(), signal, '/local/a'), (error: GitError) => error.status === 409);
    assert.equal(reads, 1);
  }
});


test('sync fetches then pushes ahead-only work without pulling or rewriting local commits', async t => {
  const { repo, origin, git, view, commands } = await setup(t);
  await writeFile(join(repo, 'top.txt'), 'ahead\n'); await git(repo, 'commit', '-qam', 'Ahead only');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'top.txt'), 'unsaved local work\n');
  await git(repo, 'config', 'pull.rebase', 'true');
  await view.sync('root', randomUUID(), signal);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(await git(origin, 'rev-parse', 'main'), head);
  assert.equal(await readFile(join(repo, 'top.txt'), 'utf8'), 'unsaved local work\n');
  assert.ok(commands.some(argv => argv.includes('fetch')));
  assert.ok(commands.some(argv => argv.includes('push')));
  assert.equal(commands.some(argv => argv.includes('pull') || argv.includes('rebase')), false);
});

test('sync fast-forwards a behind branch without rebase and refuses to hide dirty tracked changes', async t => {
  const { root, repo, origin, git, view, commands } = await setup(t), other = join(root, 'sync-other');
  await git(root, 'clone', '-q', origin, other);
  await writeFile(join(other, 'top.txt'), 'upstream\n'); await git(other, 'commit', '-qam', 'Upstream'); await git(other, 'push', '-q');
  const before = await git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'top.txt'), 'my dirty work\n');
  await assert.rejects(view.sync('root', randomUUID(), signal), /Commit or stash tracked changes/);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(repo, 'top.txt'), 'utf8'), 'my dirty work\n');
  assert.equal(commands.some(argv => argv.includes('pull') || argv.includes('push')), false);
  await git(repo, 'checkout', '--', 'top.txt'); await git(repo, 'config', 'pull.rebase', 'true');
  await view.sync('root', randomUUID(), signal);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), await git(other, 'rev-parse', 'HEAD'));
  assert.deepEqual(commands.find(argv => argv.includes('pull'))!.slice(-5), ['pull', '--no-rebase', '--ff', '--no-edit', '--no-autostash']);
});

test('sync never aborts an existing rebase and refuses detached or untracked branches before fetching', async t => {
  const { repo, git, view, commands } = await setup(t);
  await git(repo, 'switch', '-qc', 'side'); await writeFile(join(repo, 'top.txt'), 'side\n'); await git(repo, 'commit', '-qam', 'Side');
  await git(repo, 'switch', '-q', 'main'); await writeFile(join(repo, 'top.txt'), 'main\n'); await git(repo, 'commit', '-qam', 'Main');
  await assert.rejects(git(repo, 'rebase', 'side'));
  const before = await readFile(join(repo, 'top.txt'), 'utf8');
  await assert.rejects(view.sync('root', randomUUID(), signal), /rebase is in progress.*--continue.*--abort/);
  assert.equal(await readFile(join(repo, 'top.txt'), 'utf8'), before);
  assert.ok((await stat(join(repo, '.git/rebase-merge'))).isDirectory());
  assert.equal(commands.some(argv => argv.includes('fetch') || argv.includes('--abort')), false);
  await git(repo, 'rebase', '--abort'); await git(repo, 'switch', '--detach', '-q');
  await assert.rejects(view.sync('root', randomUUID(), signal), /detached HEAD/);
  await git(repo, 'switch', '-qc', 'no-upstream');
  await assert.rejects(view.sync('root', randomUUID(), signal), /requires an upstream/);
});

test('save and resolve rejects leftover markers, preserves revisions, and stages only the intended file', async t => {
  const { repo, git, view } = await setup(t), file = 'app/a.txt';
  const text = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n';
  await writeFile(join(repo, file), text); await writeFile(join(repo, 'top.txt'), 'unrelated edit\n');
  for (const content of [text, 'leftover\n=======\n', '||||||| base\n']) {
    await assert.rejects(view.saveResolve('app', 'a.txt', content, sha(text), randomUUID(), signal, join(repo, 'app')), /every conflict marker/);
  }
  assert.equal(await readFile(join(repo, file), 'utf8'), text);
  const result = await view.saveResolve('app', 'a.txt', 'resolved\n', sha(text), randomUUID(), signal, join(repo, 'app'));
  assert.deepEqual([result.revision, result.staged], [sha('resolved\n'), true]);
  assert.equal(await git(repo, 'diff', '--cached', '--name-only'), file + '\n');
  assert.equal(await git(repo, 'show', ':' + file), 'resolved\n');
  assert.equal(await readFile(join(repo, 'top.txt'), 'utf8'), 'unrelated edit\n');
  await assert.rejects(view.saveResolve('app', 'a.txt', 'stale\n', sha(text), randomUUID(), signal, join(repo, 'app')), (error: GitError) => error.status === 409);
  await assert.rejects(view.saveResolve('app', 'a.txt', 'wrong workspace\n', result.revision, randomUUID(), signal, '/other'), /workspace changed/);
});

test('save and resolve reports a saved revision when staging fails so a retry can be safe', async t => {
  const { repo, view } = await setup(t);
  await writeFile(join(repo, '.git/index.lock'), 'held');
  const response = await view.saveResolve('root', 'top.txt', 'saved resolution\n', sha('top\n'), randomUUID(), signal, repo);
  assert.equal(response.staged, false); assert.match(response.error!, /index.lock/);
  assert.equal(response.revision, sha('saved resolution\n'));
  assert.equal(await readFile(join(repo, 'top.txt'), 'utf8'), 'saved resolution\n');
});


test('sync leaves a merge conflict for review without pushing, rebasing or rolling back either side', async t => {
  const { root, repo, origin, git, view, commands } = await setup(t), other = join(root, 'conflict-other');
  await git(root, 'clone', '-q', origin, other);
  await writeFile(join(other, 'top.txt'), 'remote conflicting line\n'); await git(other, 'commit', '-qam', 'Remote conflict'); await git(other, 'push', '-q');
  await writeFile(join(repo, 'top.txt'), 'local conflicting line\n'); await git(repo, 'commit', '-qam', 'Local conflict');
  const local = await git(repo, 'rev-parse', 'HEAD'), remote = await git(origin, 'rev-parse', 'main');
  await assert.rejects(view.sync('root', randomUUID(), signal), /CONFLICT|conflict/);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), local);
  assert.equal(await git(origin, 'rev-parse', 'main'), remote);
  assert.match(await readFile(join(repo, 'top.txt'), 'utf8'), /<<<<<<< HEAD/);
  assert.equal(commands.some(argv => argv.includes('push') || argv.includes('rebase') || argv.includes('--abort')), false);
  await assert.rejects(view.sync('root', randomUUID(), signal), /merge, cherry-pick or revert is in progress/);
  const conflicted = await readFile(join(repo, 'top.txt'), 'utf8');
  const resolved = await view.saveResolve('root', 'top.txt', 'reviewed combined resolution\n', sha(conflicted), randomUUID(), signal, repo);
  assert.equal(resolved.staged, true);
  assert.equal(await git(repo, 'ls-files', '-u'), '', 'saving and resolving clears unmerged index entries');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), local, 'resolving one file does not silently commit the merge');
  assert.ok((await stat(join(repo, '.git/MERGE_HEAD'))).isFile());
});

test('cancelling a sync during fetch prevents every later phase even when the runner finishes late', async t => {
  const { repo } = await setup(t), id = randomUUID(), calls: string[] = [], cancelled: string[] = [];
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', skipped: false, truncated: false, timedOut: false });
  const view = new GitView({ cwdOf: async () => repo, remote: () => undefined, local: () => ({
    cancel: async job => { cancelled.push(job); },
    run: async batch => {
      assert.equal(batch.id, id, 'all phases keep the user-visible request ID');
      const results = [];
      for (const command of batch.commands) {
        const name = command.argv[0]; calls.push(name);
        if (name === 'fetch') { started(); await new Promise<void>(resolve => { release = resolve; }); }
        results.push(ok(name === 'status' ? 'On branch main\n' : name === 'symbolic-ref' ? 'refs/heads/main\n' : 'a'.repeat(40) + '\n'));
      }
      return results;
    },
  }) });
  const pending = view.sync('s', id, signal);
  const rejected = assert.rejects(pending, (error: GitError) => error.detail.code === 'cancelled');
  await entered; await view.cancel(id); release(); await rejected;
  assert.deepEqual(cancelled, [id]);
  assert.deepEqual(calls, ['status', 'symbolic-ref', 'rev-parse', 'fetch']);
});
