import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SshBackend } from '../src/backend.js';
import { createHandler } from '../src/http.js';
import { anchorCandidates, ensureAnchor, RemoteWorkspaces, shortHash } from '../src/remote-workspaces.js';
import { WorkspaceAccess } from '../src/workspace-access.js';
import { fixture } from './fakes.js';
import { LocalTransport } from './relay-harness.js';

const endpoint = { host: 'build-box', username: 'builder', port: 22 };
/** `ssh -G` for the fixture: URLs resolve literally; `devbox` is an ~/.ssh/config alias of build-box. */
const resolveEndpoint = async (connection: string) => {
  if (connection === 'ssh://devbox') return endpoint;
  const url = new URL(connection);
  return { host: url.hostname, username: decodeURIComponent(url.username), port: Number(url.port || 22) };
};

test('the remote shell lists subdirectories by canonical path, expands ~ and survives unusual names', async t => {
  const { directory, store } = await fixture(t);
  const home = join(directory, 'home');
  for (const name of ['b', 'a', '.hidden', 'with space', "it's", 'line\nbreak']) await mkdir(join(home, 'project', name), { recursive: true });
  await writeFile(join(home, 'project', 'file.txt'), '');
  await symlink(join(home, 'project', 'a'), join(home, 'project', 'linked'));
  const backend = new SshBackend({ id: 'host-local-1', label: 'Local', connection: 'ssh://builder@localhost' }, store, new LocalTransport(home));
  const canonicalHome = await realpath(home), project = `${canonicalHome}/project`;

  const listing = await backend.listDirectory('~/project');
  assert.equal(listing.path, project);
  assert.equal(listing.home, canonicalHome);
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.map(entry => entry.name), ['.hidden', 'a', 'b', "it's", 'linked', 'with space'], 'files and names that cannot be paths are left out');
  assert.deepEqual(listing.entries.find(entry => entry.name === "it's"), { name: "it's", path: `${project}/it's` });

  assert.equal((await backend.listDirectory(undefined)).path, canonicalHome, 'no path lists the remote home');
  assert.equal((await backend.listDirectory(`${project}/linked`, { entries: false })).path, `${project}/a`, 'symbolic links resolve to the real directory');
  assert.deepEqual((await backend.listDirectory(project, { entries: false })).entries, []);
  await assert.rejects(backend.listDirectory(`${project}/file.txt`), /Not a readable directory/);
  await assert.rejects(backend.listDirectory(`${project}/missing`), /Not a readable directory/);
});

test('anchors use dsh-remote folders and metadata, are reused, and never overwrite another directory', async t => {
  const { directory } = await fixture(t);
  const root = join(directory, 'remote-workspaces', 'build-box-builder-22');

  const app = await ensureAnchor(directory, endpoint, '/srv/app');
  assert.equal(app, join(root, 'app'));
  const meta = JSON.parse(await readFile(join(app, '.dsh-remote-meta.json'), 'utf8'));
  assert.deepEqual({ ...meta, createdAt: typeof meta.createdAt }, { host: 'build-box', port: 22, username: 'builder', remotePath: '/srv/app', createdAt: 'string' });
  assert.equal((await stat(join(app, '.dsh-remote-meta.json'))).mode & 0o777, 0o600);
  assert.equal(await ensureAnchor(directory, endpoint, '/srv/./app/'), app, 'the same directory reuses its anchor');
  assert.deepEqual(await readdir(app), ['.dsh-remote-meta.json'], 'no temporary files remain');

  const other = await ensureAnchor(directory, endpoint, '/home/builder/app');
  assert.equal(other, join(root, `app-${shortHash('/home/builder/app')}`), 'an equal basename gets dsh-remote\'s hashed folder');

  // A folder dsh-remote created keeps its metadata, including fields this plugin does not write.
  const legacy = join(root, 'web');
  await mkdir(legacy, { recursive: true });
  const saved = JSON.stringify({ host: 'build-box', port: 22, username: 'builder', remotePath: '/srv/web', alias: 'devbox', createdAt: '2026-01-01T00:00:00.000Z' });
  await writeFile(join(legacy, '.dsh-remote-meta.json'), saved);
  assert.equal(await ensureAnchor(directory, endpoint, '/srv/web'), legacy);
  assert.equal(await readFile(join(legacy, '.dsh-remote-meta.json'), 'utf8'), saved);

  // Both candidates belong to other directories: refuse rather than repoint either.
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, `docs-${shortHash('/srv/docs')}`), { recursive: true });
  await assert.rejects(ensureAnchor(directory, endpoint, '/srv/docs'), /Another folder already uses this workspace name/);

  assert.deepEqual(anchorCandidates(directory, endpoint, '/srv/a\\..').map(path => path.slice(root.length + 1)), ['workspace', `workspace-${shortHash('/srv/a\\..')}`], 'a backslash name cannot climb out of the machine folder');
});

test('concurrent adoption gives each remote directory its own anchor and one anchor per directory', async t => {
  const { directory } = await fixture(t);
  for (let round = 0; round < 20; round++) {
    const home = join(directory, `round-${round}`);
    const [first, second] = await Promise.all([ensureAnchor(home, endpoint, '/srv/app'), ensureAnchor(home, endpoint, '/home/user/app')]);
    assert.notEqual(first, second, 'two directories with one basename never share an anchor');
    for (const [anchor, path] of [[first, '/srv/app'], [second, '/home/user/app']]) {
      assert.equal(JSON.parse(await readFile(join(anchor, '.dsh-remote-meta.json'), 'utf8')).remotePath, path);
    }
    const same = await Promise.all(Array.from({ length: 5 }, () => ensureAnchor(home, endpoint, '/srv/web')));
    assert.equal(new Set(same).size, 1, 'concurrent requests for one directory reuse one anchor');
    assert.deepEqual((await readdir(join(home, 'remote-workspaces', 'build-box-builder-22'))).sort(), [first, second, same[0]].map(anchor => basename(anchor)).sort(), 'no staging folders remain');
  }
});

test('directory names up to the 255-byte limit are adopted, including shared long names', async t => {
  const { directory } = await fixture(t);
  const bytes = (name: string) => Buffer.byteLength(name);
  for (const [label, name] of [['214 ASCII bytes', 'a'.repeat(214)], ['255 ASCII bytes', 'b'.repeat(255)], ['255 bytes of CJK', '工'.repeat(85)]] as const) {
    const home = join(directory, label.replace(/\W+/g, '-')), root = join(home, 'remote-workspaces', 'build-box-builder-22');
    const plain = await ensureAnchor(home, endpoint, `/srv/${name}`);
    assert.equal(plain, join(root, name), `${label}: the folder keeps the directory's name`);
    // A second directory with the same name gets a hashed folder name, shortened to fit.
    const other = await ensureAnchor(home, endpoint, `/home/user/${name}`);
    const hashed = basename(other), suffix = `-${shortHash(`/home/user/${name}`)}`;
    assert.ok(hashed.endsWith(suffix) && name.startsWith(hashed.slice(0, -suffix.length)) && bytes(hashed) <= 255, `${label}: ${bytes(hashed)} bytes`);
    assert.ok(!hashed.includes('�'), `${label}: no character is split`);
    for (const [anchor, path] of [[plain, `/srv/${name}`], [other, `/home/user/${name}`]]) {
      assert.equal(JSON.parse(await readFile(join(anchor, '.dsh-remote-meta.json'), 'utf8')).remotePath, path);
    }
    assert.equal(await ensureAnchor(home, endpoint, `/home/user/${name}`), other, `${label}: the shortened folder is found again`);
    assert.deepEqual((await readdir(root)).sort(), [basename(plain), hashed].sort(), `${label}: no staging folders remain`);
  }
  // A machine address longer than one path segment is shortened too.
  const long = { host: `${'h'.repeat(250)}.example`, username: 'builder', port: 22 };
  const anchor = await ensureAnchor(join(directory, 'long-host'), long, '/srv/app');
  assert.ok(bytes(basename(dirname(anchor))) <= 255);
});

test('adopting a remote directory canonicalizes it on the host and admits that host\'s models', async t => {
  const { directory, store, service, hostId } = await fixture(t);
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'), endpoint: resolveEndpoint });
  const workspaces = new RemoteWorkspaces(service, access, { home: directory, endpoint: resolveEndpoint });

  const created = await workspaces.create(hostId, '~/app');
  assert.deepEqual(created, { hostId, path: join(directory, 'remote-workspaces', 'build-box-builder-22', 'app'), remotePath: '/home/builder/app' });
  assert.deepEqual(await access.resolve(join(created.path)), { hostIds: [hostId], cwd: '/home/builder/app' });
  assert.deepEqual(await workspaces.create(hostId, '/home/builder/app'), created, 'adopting it again reuses the workspace');

  await assert.rejects(workspaces.create(hostId, '/srv/missing'), /Not a readable directory/);
  const unmatched = new RemoteWorkspaces(service, new WorkspaceAccess(() => [], { home: directory, omc: join(directory, 'omc'), endpoint: resolveEndpoint }), { home: directory, endpoint: resolveEndpoint });
  await assert.rejects(unmatched.create(hostId, '/srv/app'), /could not be matched/);
  assert.equal((await service.snapshot()).hosts[0].status, 'connected', 'a missing directory does not mark the host as failed');
});

test('dsh-remote folders saved with an ~/.ssh/config alias match through the alias', async t => {
  const { directory, store, hostId } = await fixture(t);
  const mirror = join(directory, 'remote-workspaces', 'devbox-builder-22', 'app');
  await mkdir(mirror, { recursive: true });
  const meta = { host: 'devbox', username: 'builder', port: 22, remotePath: '/srv/app' };
  await writeFile(join(mirror, '.dsh-remote-meta.json'), JSON.stringify(meta));
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'), endpoint: resolveEndpoint });
  assert.deepEqual(await access.resolve(mirror), { hostIds: [], cwd: '/srv/app' }, 'the literal address alone does not match');
  await writeFile(join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ ...meta, alias: 'devbox' }));
  assert.deepEqual(await access.resolve(mirror), { hostIds: [hostId], cwd: '/srv/app' });
  await writeFile(join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ ...meta, alias: '-oProxyCommand=evil' }));
  assert.deepEqual(await access.resolve(mirror), { hostIds: [], cwd: '/srv/app' }, 'an invalid alias is ignored');
});

test('the settings API browses hosts and adopts workspaces', async t => {
  const { directory, store, service, hostId } = await fixture(t);
  const access = new WorkspaceAccess(() => store.hosts(), { home: directory, omc: join(directory, 'omc'), endpoint: resolveEndpoint });
  const handler = createHandler(service, undefined, undefined, new RemoteWorkspaces(service, access, { home: directory, endpoint: resolveEndpoint }));
  const call = async (body: Record<string, unknown>) => {
    const response = await handler(new Request('http://dsh/api/remote-agents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual((await call({ action: 'browse', hostId })).body, { path: '/home/builder', home: '/home/builder', truncated: false, entries: [{ name: 'app', path: '/home/builder/app' }, { name: 'notes', path: '/home/builder/notes' }] });
  assert.equal((await call({ action: 'browse', hostId, path: 'relative/dir' })).status, 400);
  const created = await call({ action: 'createWorkspace', hostId, path: '/srv/app' });
  assert.equal(created.status, 200);
  assert.equal(created.body.remotePath, '/srv/app');
  assert.equal((await call({ action: 'createWorkspace', hostId, path: '/srv/missing' })).status, 502);
  assert.equal((await createHandler(service)(new Request('http://dsh/api/remote-agents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify({ action: 'createWorkspace', hostId, path: '/srv/app' }) }))).status, 501);
});
