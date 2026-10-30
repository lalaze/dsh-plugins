import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { installFakeMonaco, type FakeMonaco } from '@dsh-plugins/file-view/testing';
import type { Overview } from '../src/domain.js';
import { parseConflicts, resolveConflict } from '../src/client/conflicts.js';
import { layoutGraph } from '../src/client/graph.js';
import { setSessions, type SessionSummary } from '../src/client/sessions.js';
import { StatusCache, statusLetter } from '../src/client/status.js';
import { registerComposer, sendToComposer } from '../src/client/composer.js';
import { zh } from '../src/client/locales.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let root: Root | undefined, container: HTMLElement, fake: FakeMonaco;
let requests: Record<string, unknown>[], routes: Record<string, (body: Record<string, unknown>) => unknown>;
const globals = ['window', 'document', 'navigator', 'MutationObserver', 'getComputedStyle', 'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent', 'KeyboardEvent',
  'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'fetch'] as const;
/** Replies with JSON, or with `{ status, error, ... }` for an error. */
const reply = (value: unknown) => {
  const failure = value as { status?: number; error?: string } | undefined;
  return failure && typeof failure.status === 'number' && failure.error ? Response.json(failure, { status: failure.status }) : Response.json(value ?? {});
};
const sessions = (byId: Record<string, SessionSummary>) => {
  const listeners = new Set<() => void>();
  setSessions({ list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } } });
};
beforeEach(() => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  fake = installFakeMonaco();
  requests = []; routes = {};
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); requests.push(body);
    const route = routes[body.action];
    if (!route) return Response.json({ error: `No route for ${body.action}` }, { status: 404 });
    return reply(await route(body));
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? window : name === 'fetch' ? fetch : (window as unknown as Record<string, unknown>)[name] });
  (window as unknown as { confirm(): boolean }).confirm = () => true;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container);
  sessions({ s1: { cwd: '/repo', retainedBy: { mainView: 1 } } });
});
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined;
  setSessions(undefined);
  for (const name of globals) delete (globalThis as Record<string, unknown>)[name];
});
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); });
async function mount(element: React.ReactElement) {
  const { createRoot } = await import('react-dom/client');
  root = createRoot(container);
  await act(async () => root!.render(element)); await settle();
}
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label || b.title === label)!;
const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const commit = (subject: string, sha: string, parents: string[] = []) => ({ sha, parents, author: 'Ana', date: '2026-10-30 10:00:00 +0800', subject });
const overview = (patch: Partial<Overview> = {}): Overview => ({
  location: { kind: 'local' }, repo: 'repo', current: 'main', prefix: '',
  local: [{ name: 'main', sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-10-30 10:00:00 +0800', subject: 'Main work', upstream: 'origin/main', ahead: 1, behind: 2, current: true },
    { name: 'topic', sha: 'b'.repeat(40), short: 'bbbbbbb', date: '2026-10-29 10:00:00 +0800', subject: 'Topic work', current: false }],
  remote: [{ name: 'origin/main', sha: 'c'.repeat(40), short: 'ccccccc', date: '2026-10-28 10:00:00 +0800', subject: 'Remote', current: false }],
  commits: [commit('Main work', 'a'.repeat(40), ['c'.repeat(40)]), commit('Remote', 'c'.repeat(40))], tips: { main: 'a'.repeat(40), 'origin/main': 'c'.repeat(40) },
  changes: [{ code: 'UU', path: 'src/conflict.ts', local: 'src/conflict.ts' }, { code: 'M ', path: 'staged.ts', local: 'staged.ts' }, { code: ' M', path: 'src/a.ts', local: 'src/a.ts' }],
  ...patch,
});

test('conflict blocks resolve to either side or both, keeping CRLF and ignoring a diff3 base', () => {
  const text = 'top\r\n<<<<<<< HEAD\r\nours\r\n||||||| base\r\nold\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\nend\r\n';
  const [block] = parseConflicts(text);
  assert.deepEqual([block.start, block.middle, block.end, block.ours, block.theirs, block.label], [1, 5, 7, 'ours\r\n', 'theirs\r\n', 'feature']);
  assert.equal(resolveConflict(text, block, 'ours'), 'top\r\nours\r\nend\r\n');
  assert.equal(resolveConflict(text, block, 'theirs'), 'top\r\ntheirs\r\nend\r\n');
  assert.equal(resolveConflict(text, block, 'both'), 'top\r\nours\r\ntheirs\r\nend\r\n');
  assert.deepEqual(parseConflicts('no markers\n'), []);
});
test('graph lanes: a merge opens a second lane and the main line keeps the first', () => {
  const layout = layoutGraph([commit('Merge', 'm', ['a', 'b']), commit('Side', 'b', ['r']), commit('Main', 'a', ['r']), commit('Root', 'r')]);
  assert.deepEqual(layout.map(c => [c.sha, c.row, c.lane]), [['m', 0, 0], ['b', 1, 1], ['a', 2, 0], ['r', 3, 0]]);
  assert.deepEqual(['??', 'UU', ' D', 'R ', 'A ', ' M'].map(statusLetter), ['U', 'C', 'D', 'R', 'A', 'M']);
});
test('the status cache refreshes a folder through a conversation working in it and reports changes once', async () => {
  const asked: unknown[] = [];
  const cache = new StatusCache(async (_action, data) => { asked.push(data); return { prefix: '', changes: [{ code: ' M', path: 'src/a.ts', local: 'src/a.ts' }] } as never; });
  let notified = 0;
  cache.subscribe(() => notified++);
  await cache.ensure('/repo'); await cache.ensure('/repo');
  assert.deepEqual(asked, [{ sessionId: 's1' }], 'a fresh status is not read again');
  assert.deepEqual([cache.isChanged('/repo', 'src/a.ts'), cache.hasChangesUnder('/repo', 'src'), cache.isChanged('/repo', 'b.ts'), notified], [true, true, false, 1]);
  await cache.ensure('/repo', true);
  assert.equal(notified, 1, 'an unchanged status notifies nobody');
  await cache.ensure('/elsewhere');
  assert.equal(asked.length, 2, 'no conversation works in that folder');
  // A folder outside Git is not asked again on every poll.
  sessions({ s1: { cwd: '/repo' }, s2: { cwd: '/plain' } });
  let failures = 0;
  const outside = new StatusCache(async () => { failures++; throw new Error('This folder is not a Git repository'); });
  await outside.ensure('/plain'); await outside.ensure('/plain');
  assert.equal(failures, 1);
  await outside.ensure('/plain', true);
  assert.equal(failures, 2, 'a forced refresh still asks');
});
test('text goes into the conversation’s composer after its draft, as one insertion', () => {
  const inserted: string[] = [];
  const off = registerComposer('s1', { actions: { captureInsertion: () => 'span', insertText: (text, span) => { inserted.push(`${span}:${text}`); return true; }, setDraft: () => assert.fail() }, draft: () => 'draft' });
  assert.equal(sendToComposer('s1', 'prompt'), true);
  assert.deepEqual(inserted, ['span:\n\nprompt']);
  off();
  let draft = '';
  registerComposer('s1', { actions: { setDraft: text => { draft = text; } }, draft: () => '' });
  sendToComposer('s1', 'only');
  assert.equal(draft, 'only');
});

test('the Git view shows branches and changes, commits, stages and opens a changed file’s diff', async () => {
  const { GitPanel } = await import('../src/client/panel.js');
  let reloads = 0;
  routes.overview = () => { reloads++; return overview(); };
  routes.commit = () => ({ output: '[main 1234567] Fix it' });
  routes.stage = () => ({ output: '' });
  routes.status = () => ({ prefix: '', changes: [] });
  const opened: string[] = [];
  await mount(<GitPanel sessionId="s1" cwd="/repo" cache={new StatusCache()} openDiff={path => { opened.push(path); return true; }} />);
  assert.equal(container.querySelector('.gv-repo')!.textContent, 'repo');
  assert.deepEqual([...container.querySelectorAll('.gv-branch-name')].map(e => e.textContent), ['main', 'topic', 'origin/main']);
  assert.deepEqual([...container.querySelectorAll('.gv-group-head')].map(e => e.textContent), ['Merge conflicts (1)', 'Staged changes (1)', 'Changes (1)']);
  assert.ok(container.querySelector('.gv-banner'));
  await type(container.querySelector<HTMLInputElement>('input[aria-label="Commit message"]')!, 'Fix it');
  await click(button('Commit')); await settle();
  const committed = requests.find(r => r.action === 'commit')!;
  assert.equal(committed.message, 'Fix it'); assert.match(String(committed.requestId), /^[0-9a-f-]{36}$/);
  assert.equal(container.querySelector('.gv-notice')!.textContent, '[main 1234567] Fix it');
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Commit message"]')!.value, '');
  assert.ok(reloads >= 2, 'the view reloads after a change');
  const rows = [...container.querySelectorAll<HTMLElement>('.gv-change')];
  await click(rows[2]);
  assert.deepEqual(opened, ['src/a.ts']);
  await click(rows[2].querySelector('[aria-label="Stage"]')!); await settle();
  assert.equal(requests.find(r => r.action === 'stage')!.path, 'src/a.ts');
  routes.diff = () => ({ output: '@@ -1,2 +1,2 @@\n a\n-b\n+B\n' });
  await click(rows[1]); await settle();
  assert.equal(requests.findLast(r => r.action === 'diff')!.staged, true);
  await click(rows[2].querySelector('[aria-label="Show the diff here"]')!); await settle();
  assert.equal(requests.findLast(r => r.action === 'diff')!.staged, false);
  assert.deepEqual([...container.querySelectorAll('.gv-line')].map(e => e.getAttribute('data-kind')), ['hunk', null, 'del', 'add', null]);
});

test('a running pull is cancelled with its own request ID, and the result stays with the folder', async () => {
  const { GitPanel } = await import('../src/client/panel.js');
  routes.overview = () => overview();
  let release = () => {};
  routes.pull = () => new Promise(resolve => { release = () => resolve({ status: 409, error: 'The Git operation was cancelled', code: 'cancelled' }); });
  routes.cancel = () => { release(); return { ok: true }; };
  await mount(<GitPanel sessionId="s1" cwd="/repo" cache={new StatusCache()} />);
  await click(container.querySelector('button[data-kind="behind"]')!); await settle();
  assert.ok(container.querySelector('.gv-progress'));
  assert.match(container.querySelector('.gv-notice')!.textContent!, /Running Pull…/);
  await click(button('Cancel')); await settle();
  const pull = requests.find(r => r.action === 'pull')!, cancel = requests.find(r => r.action === 'cancel')!;
  assert.equal(cancel.requestId, pull.requestId);
  assert.equal(container.querySelector('.gv-notice')!.textContent, 'The Git operation was cancelled');
  assert.equal(container.querySelector('.gv-progress'), null);
  // Reopening the tab shows the folder's last message again.
  await act(async () => root!.unmount());
  await mount(<GitPanel sessionId="s1" cwd="/repo" cache={new StatusCache()} />);
  assert.equal(container.querySelector('.gv-notice')!.textContent, 'The Git operation was cancelled');
});

test('a local HTTPS sign-in failure offers to save a credential and retries; a remote one explains what to set up there', async () => {
  const { GitPanel } = await import('../src/client/panel.js');
  routes.overview = () => overview();
  let pushes = 0;
  routes.push = () => ++pushes === 1 ? { status: 422, error: "fatal: could not read Username for 'https://git.example.com': terminal prompts disabled", auth: 'https' } : { output: 'pushed' };
  routes.credentialTarget = () => ({ host: 'git.example.com', username: 'bob' });
  routes.saveCredential = () => ({ ok: true });
  await mount(<GitPanel sessionId="s1" cwd="/repo" cache={new StatusCache()} />);
  await click(button('Push')); await settle();
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Host"]')!.value, 'git.example.com');
  assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Username"]')!.value, 'bob');
  await type(container.querySelector<HTMLInputElement>('input[aria-label="Password or access token"]')!, 'token');
  await click(button('Save and retry')); await settle();
  assert.deepEqual(requests.find(r => r.action === 'saveCredential'), { action: 'saveCredential', sessionId: 's1', host: 'git.example.com', username: 'bob', password: 'token' });
  assert.equal(pushes, 2);
  assert.equal(container.querySelector('.gv-notice')!.textContent, 'pushed');
  await act(async () => root!.unmount());
  sessions({ s2: { cwd: '/home/me/.dsh/remote-workspaces/devbox-me-22/app', retainedBy: { mainView: 1 } } });
  routes.overview = () => overview({ location: { kind: 'remote', host: 'devbox', cwd: '/srv/app' } });
  routes.push = () => ({ status: 422, error: 'remote: HTTP Basic: Access denied', auth: 'https' });
  await mount(<GitPanel sessionId="s2" cwd="/home/me/.dsh/remote-workspaces/devbox-me-22/app" cache={new StatusCache()} />);
  assert.equal(container.querySelector('.gv-host')!.textContent, 'devbox');
  await click(button('Push')); await settle();
  assert.equal(container.querySelector('input[aria-label="Host"]'), null, 'remote machines keep their own credentials');
  assert.match(container.querySelector('.gv-auth')!.textContent!, /Git on devbox could not sign in/);
});

test('the branch menu renames, deletes and merges; double-clicking a remote branch checks it out', async () => {
  const { GitPanel } = await import('../src/client/panel.js');
  routes.overview = () => overview();
  for (const action of ['rename', 'deleteBranch', 'merge', 'switch', 'deleteRemoteBranch']) routes[action] = () => ({ output: '' });
  await mount(<GitPanel sessionId="s1" cwd="/repo" cache={new StatusCache()} />);
  const branch = (name: string) => [...container.querySelectorAll('.gv-branch')].find(b => b.querySelector('.gv-branch-name')!.textContent === name)!;
  const menu = (name: string) => act(async () => { branch(name).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
  await menu('topic');
  await click(button('Rename…'));
  await type(container.querySelector<HTMLInputElement>('input[aria-label="New branch name"]')!, 'renamed');
  await act(async () => { container.querySelector('.gv-menu form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); await settle();
  assert.deepEqual(requests.filter(r => r.action === 'rename').map(r => [r.branch, r.to]), [['topic', 'renamed']]);
  await menu('topic'); await click(button('Merge into the current branch')); await settle();
  await menu('topic'); await click(button('Delete branch')); await click(button('Delete')); await settle();
  await menu('origin/main'); await click(button('Delete remote branch')); await click(button('Delete')); await settle();
  await menu('main');
  assert.equal(button('Delete branch'), undefined, 'the current branch cannot be deleted');
  assert.equal(button('Merge into the current branch'), undefined);
  await click(container.querySelector('.gv-menu-backdrop')!);
  await act(async () => { branch('origin/main').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); }); await settle();
  assert.deepEqual(requests.filter(r => ['merge', 'deleteBranch', 'deleteRemoteBranch', 'switch'].includes(String(r.action))).map(r => [r.action, r.branch, r.remote]),
    [['merge', 'topic', undefined], ['deleteBranch', 'topic', undefined], ['deleteRemoteBranch', 'origin/main', undefined], ['switch', 'origin/main', true]]);
});

test('changes and conflicts are sent to the conversation’s composer', async () => {
  const { GitPanel } = await import('../src/client/panel.js');
  routes.overview = () => overview();
  const inserted: string[] = [];
  const off = registerComposer('s1', { actions: { captureInsertion: () => 0, insertText: text => { inserted.push(text); return true; }, setDraft: () => {} }, draft: () => '' });
  await mount(<GitPanel sessionId="s1" cwd="/repo" cache={new StatusCache()} />);
  await click(button('Send conflict analysis to chat'));
  assert.match(inserted[0], /merge conflicts in these files:\n- `src\/conflict\.ts` \(CONFLICT\)\n\nOther changed files: 2\./);
  assert.equal(container.querySelector('.gv-notice')!.textContent, 'Added to the message box');
  off();
});

test('the diff tab compares with HEAD, saves edits over the version read, and refuses a stale save', async () => {
  const { DiffTab } = await import('../src/client/diff-tab.js');
  const opened: unknown[] = [];
  let disk = 'a\nB\n';
  routes.compare = () => ({ location: { kind: 'local' }, path: 'src/a.ts', repoPath: 'app/src/a.ts', head: { kind: 'text', content: 'a\nb\n' },
    working: { kind: 'text', content: disk, revision: sha(disk), size: disk.length }, code: ' M' });
  routes.save = body => body.revision === sha(disk) ? (disk = String(body.content), { revision: sha(disk) }) : { status: 409, error: 'The file changed on disk. Reload it before saving.' };
  routes.stage = () => ({ output: '' });
  routes.status = () => ({ prefix: '', changes: [] });
  await mount(<DiffTab address="dsh-resource://file/session/s1/src/a.ts" cache={new StatusCache()} tools={{ openResource: (...args) => opened.push(args) }} viewers={() => 'text'} />);
  const diff = fake.diffs[0];
  assert.deepEqual([diff.getModel()!.original.getValue(), diff.getModel()!.modified.getValue()], ['a\nb\n', 'a\nB\n']);
  assert.equal(container.querySelector('.gv-stat')!.textContent, '+1−1');
  assert.equal(container.querySelector('.gv-letter')!.textContent, 'M');
  await act(async () => diff.getModel()!.modified.setValue('a\nC\n'));
  await click(button('Save (⌘/Ctrl+S)')); await settle();
  assert.equal(disk, 'a\nC\n');
  assert.equal(requests.find(r => r.action === 'save')!.revision, sha('a\nB\n'));
  disk = 'changed elsewhere\n';
  await act(async () => diff.getModel()!.modified.setValue('a\nD\n'));
  await click(button('Save (⌘/Ctrl+S)')); await settle();
  assert.match(container.querySelector('.gv-notes')!.textContent!, /The file changed on disk\./);
  await click(button('Stage this file')); await settle();
  assert.equal(requests.find(r => r.action === 'stage')!.path, 'app/src/a.ts');
  await click(button('Open the file'));
  assert.deepEqual(opened, [['dsh-resource://file/session/s1/src/a.ts', { kind: 'text' }]]);
  await click(button('Inline'));
  assert.equal(diff.getRawOptions().renderSideBySide, false);
});

test('an open diff reloads when Git reports the file differently, and keeps unsaved edits instead', async () => {
  const { DiffTab } = await import('../src/client/diff-tab.js');
  let disk = 'first\n';
  routes.compare = () => ({ location: { kind: 'local' }, path: 'a.ts', repoPath: 'a.ts', head: { kind: 'text', content: 'base\n' },
    working: { kind: 'text', content: disk, revision: sha(disk), size: disk.length }, code: ' M' });
  const cache = new StatusCache();
  await mount(<DiffTab address="dsh-resource://file/session/s1/a.ts" cache={cache} />);
  const modified = () => fake.diffs[0].getModel()!.modified;
  disk = 'merged\n';
  await act(async () => cache.set('/repo', { prefix: '', changes: [{ code: 'UU', path: 'a.ts', local: 'a.ts' }] })); await settle();
  assert.equal(modified().getValue(), 'merged\n');
  await act(async () => modified().setValue('my edit\n'));
  disk = 'again\n';
  await act(async () => cache.set('/repo', { prefix: '', changes: [{ code: ' M', path: 'a.ts', local: 'a.ts' }] })); await settle();
  assert.equal(modified().getValue(), 'my edit\n');
  assert.match(container.querySelector('.gv-notes')!.textContent!, /The file changed on disk\./);
});

test('a conflicted file opens on its conflicts; resolving every block and saving writes the result', async () => {
  const { DiffTab } = await import('../src/client/diff-tab.js');
  const text = 'start\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nend\n';
  routes.compare = () => ({ location: { kind: 'local' }, path: 'c.txt', repoPath: 'c.txt', head: { kind: 'text', content: 'start\nend\n' },
    working: { kind: 'text', content: text, revision: sha(text), size: text.length }, code: 'UU' });
  routes.save = () => ({ revision: sha('x') });
  routes.status = () => ({ prefix: '', changes: [] });
  await mount(<DiffTab address="dsh-resource://file/session/s1/c.txt" cache={new StatusCache()} />);
  assert.match(container.querySelector('.gv-block-head')!.textContent!, /Conflict 1 of 1 · lines 2–6/);
  assert.equal(container.querySelector('.gv-letter')!.textContent, 'C');
  await click(button('Accept incoming (feature)'));
  assert.match(container.querySelector('.gv-resolved')!.textContent!, /Every conflict block is resolved/);
  await click(button('Save (⌘/Ctrl+S)')); await settle();
  assert.equal(requests.find(r => r.action === 'save')!.content, 'start\ntheirs\nend\n');
});

test('change marks follow DSH’s file tree and Remote Agents’ remote list, and leave with the changes', async () => {
  const { installDecorations } = await import('../src/client/decorations.js');
  sessions({ s1: { cwd: '/repo' }, r1: { cwd: '/home/me/.dsh/remote-workspaces/box/app' } });
  container.innerHTML = `<div data-files-state="tree" data-files-root="/repo"><ul>
    <li data-files-entry="directory" data-files-path="/repo/src"><button><span>src</span></button></li>
    <li data-files-entry="file" data-files-path="/repo/src/a.ts"><button><span>a.ts</span></button></li>
    <li data-files-entry="file" data-files-path="/repo/b.ts"><button><span>b.ts</span></button></li></ul></div>
    <div data-workspace-session="r1"><button data-workspace-path="x.txt" data-workspace-kind="file"><span data-workspace-name="">x.txt</span><small>1 KB</small></button></div>`;
  const cache = new StatusCache(async () => { throw new Error('offline'); }), ensured = new Set<string>();
  cache.set('/repo', { prefix: '', changes: [{ code: ' M', path: 'src/a.ts', local: 'src/a.ts' }] });
  cache.set('/home/me/.dsh/remote-workspaces/box/app', { prefix: '', changes: [{ code: '??', path: 'x.txt', local: 'x.txt' }] });
  const off = installDecorations(cache, root => ensured.add(root));
  const frame = () => act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))); });
  await frame();
  const name = (path: string) => container.querySelector(`[data-files-path="${path}"] span`)!;
  assert.equal(name('/repo/src/a.ts').textContent, 'a.tsM');
  assert.equal(name('/repo/src').textContent, 'src•');
  assert.equal(name('/repo/b.ts').textContent, 'b.ts');
  const remote = container.querySelector('[data-workspace-path="x.txt"]')!;
  assert.deepEqual([...remote.children].map(e => e.textContent), ['x.txt', 'U', '1 KB']);
  assert.deepEqual([...ensured].sort(), ['/home/me/.dsh/remote-workspaces/box/app', '/repo']);
  cache.set('/repo', { prefix: '', changes: [] }); await frame();
  assert.equal(name('/repo/src/a.ts').textContent, 'a.ts');
  assert.equal((name('/repo/src/a.ts') as HTMLElement).style.color, '');
  off();
});

test('the composer bridge shows nothing and lends the composer to "send to chat"', async () => {
  const { ComposerBridge } = await import('../src/client/dock.js');
  let draft = 'draft';
  const actions = { setDraft: (text: string) => { draft = text; } };
  await mount(<ComposerBridge sessionId="s1" inputActions={actions} useInput={select => select({ draft })} />);
  assert.equal(container.innerHTML, '');
  assert.equal(sendToComposer('s1', 'review'), true);
  assert.equal(draft, 'draft\n\nreview');
});

test('in a Remote Agents workspace, dsh-git-panel\'s tab shows this Git view; elsewhere its own', async () => {
  const { takeOverGitPanel, GIT_PANEL_VIEW } = await import('../src/client/takeover.js');
  type Entry = { component: React.FC<any>; options: Record<string, unknown> };
  let entries: Entry[] = [];
  const listeners = new Set<() => void>(), notify = () => { for (const listener of [...listeners]) listener(); };
  const slots = {
    entries: () => entries,
    subscribe: (_key: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register: (spec: Record<string, unknown>, component: React.FC<any>) => {
      const { name: _, ...options } = spec, entry = { component, options };
      entries = [...entries, entry]; queueMicrotask(notify);
      return () => { entries = entries.filter(e => e !== entry); queueMicrotask(notify); };
    },
  };
  const label = () => 'Git';
  const Theirs: React.FC<{ sessionId: string }> = ({ sessionId }) => <p>theirs {sessionId}</p>;
  const Remote: React.FC<{ sessionId: string }> = ({ sessionId }) => <p>ours {sessionId}</p>;
  const off = takeOverGitPanel(slots, Remote);
  assert.equal(entries.length, 0, 'nothing to stand in for without dsh-git-panel');
  const disposeTheirs = slots.register({ name: 'conversation.view', id: GIT_PANEL_VIEW, order: 30, label }, Theirs);
  await settle();
  const ours = entries.find(e => e.component !== Theirs)!;
  assert.deepEqual(ours.options, { id: GIT_PANEL_VIEW, priority: -1, order: 30, label });
  sessions({ s1: { cwd: '/repo' }, s2: { cwd: '/home/me/.dsh/remote-workspaces/box/app' } });
  const View = ours.component;
  await mount(<><View sessionId="s1" /><View sessionId="s2" /></>);
  assert.deepEqual([...container.querySelectorAll('p')].map(p => p.textContent), ['theirs s1', 'ours s2']);
  disposeTheirs(); await settle();
  assert.equal(entries.length, 0, 'leaves with dsh-git-panel');
  slots.register({ name: 'conversation.view', id: GIT_PANEL_VIEW, order: 30, label }, Theirs); await settle();
  assert.equal(entries.length, 2);
  off();
  assert.deepEqual(entries.map(e => e.component), [Theirs]);
});

test('the plugin adds the Git tab with its guide entry and claims only changed text files', async () => {
  const client = await import('../src/client/index.js');
  const definitions: Record<string, unknown>[] = [], slots: string[] = [], previews: { id: string; priority: string; extensions: string[] }[] = [];
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { cwd: '/repo', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    sidebarRight: { openResource: () => {} },
    sidebarRightTabs: { register: (definition: Record<string, unknown>) => { definitions.push(definition); return () => {}; }, candidates: () => [{ kind: 'git-view/diff' }, { kind: 'file-editor/file' }] },
    documentPreviews: {
      getSnapshot: () => [{ id: 'code', priority: 'builtin', extensions: ['ts', 'md', 'png'] }, { id: 'other', priority: 'extension', extensions: ['py'] }, ...previews],
      register: (definition: { id: string; priority: string; extensions: string[] }) => { previews.push(definition); return () => { previews.splice(previews.indexOf(definition), 1); }; },
    },
  };
  routes.status = () => ({ prefix: '', changes: [{ code: ' M', path: 'src/a.ts', local: 'src/a.ts' }, { code: ' M', path: 'logo.png', local: 'logo.png' }] });
  const disposers: (() => void)[] = [];
  const ctx = {
    get: (name: string) => services[name],
    effect: (factory: () => () => void) => { disposers.push(factory()); },
    inject: (names: string[], factory: (scoped: unknown) => void) => { if (names.every(name => services[name])) factory(ctx); },
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: (spec: Record<string, unknown>) => { slots.push(String(spec.key ?? spec.id)); return () => {}; } },
  };
  client.apply(ctx as never);
  await settle();
  assert.deepEqual(definitions.map(d => d.kind), ['git-view/git', 'git-view/diff']);
  assert.equal((definitions[0].guide as { id: string }[])[0].id, 'git-view');
  assert.deepEqual(slots, ['git-view/git', 'git-view/diff', 'git-view/preview', 'git-view-composer']);
  // Only beside DSH's own viewers, in their band, so it never becomes the viewer a file opens with.
  assert.deepEqual(previews.map(p => [p.id, p.priority, p.extensions]), [['git-view/preview', 'builtin', ['ts', 'md']]]);
  const canOpen = definitions[1].canOpen as (address: string) => boolean;
  assert.equal(canOpen('dsh-resource://file/session/s1/src/a.ts'), true);
  assert.equal(canOpen('dsh-resource://file/session/s1/logo.png'), false, 'images keep DSH’s preview');
  assert.equal(canOpen('dsh-resource://file/session/s1/README.md'), false, 'unchanged files keep their viewer');
  for (const dispose of disposers) dispose();
});

test('explicit diff and ordinary viewers use the public navigator, not kind-dropping tab actions', async () => {
  const client = await import('../src/client/index.js');
  const opened: unknown[] = [], components = new Map<string, React.ComponentType<any>>(), disposers: (() => void)[] = [];
  const sidebar = { openResource(address: string, options?: Record<string, unknown>) {
    assert.equal(this, sidebar, 'the public service retains its method receiver'); opened.push([address, options]);
  } };
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { cwd: '/repo', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    sidebarRight: sidebar,
    sidebarRightTabs: { register: () => () => {}, candidates: () => [{ kind: client.DIFF_KIND }, { kind: 'text' }] },
  };
  const ctx = {
    get: (name: string) => services[name],
    effect: (factory: () => () => void) => { disposers.push(factory()); },
    inject: (names: string[], factory: (scope: unknown) => void) => { if (names.every(name => services[name])) factory(ctx); },
    slots: { inject: (_name: string, factory: () => unknown) => factory(), register: (spec: Record<string, unknown>, component: React.ComponentType<any>) => {
      components.set(String(spec.key ?? spec.id), component); return () => {};
    } },
  };
  routes.status = () => ({ prefix: '', changes: [{ code: ' M', path: 'src/a.ts', local: 'src/a.ts' }] });
  routes.overview = () => overview();
  routes.compare = () => ({ location: { kind: 'local' }, path: 'src/a.ts', repoPath: 'src/a.ts', code: ' M',
    head: { kind: 'text', content: 'before\n' }, working: { kind: 'text', content: 'after\n', revision: sha('after\n'), size: 6 } });
  const address = 'dsh-resource://file/session/s1/src/a.ts';
  // Real DSH Tab actions strip `kind`; using this path would silently reopen the default diff.
  const useTabInfo = () => ({ tab: { navigation: { address }, actions: { openResource: () => assert.fail('tab action loses explicit kind') } } });
  client.apply(ctx as never);
  try {
    const Git = components.get(client.GIT_KIND)!;
    await mount(<Git sessionId="s1" useTabInfo={useTabInfo} />);
    await click([...container.querySelectorAll('.gv-change')].find(row => row.textContent?.includes('src/a.ts'))!);
    assert.deepEqual(opened, [[address, { kind: client.DIFF_KIND }]]);
    await act(async () => root!.unmount()); root = undefined;
    const Diff = components.get(client.DIFF_KIND)!;
    await mount(<Diff sessionId="s1" useTabInfo={useTabInfo} />);
    await click(button('Open the file'));
    assert.deepEqual(opened.at(-1), [address, { kind: 'text' }]);
  } finally {
    await act(async () => root?.unmount()); root = undefined;
    for (const dispose of disposers.reverse()) dispose();
  }
});

test('every interface string and known error has a Chinese translation', () => {
  const dir = new URL('../src/', import.meta.url), missing: string[] = [];
  const files = [...readdirSync(new URL('client/', dir)).map(f => new URL(`client/${f}`, dir)), ...readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => new URL(f, dir))];
  for (const file of files) {
    const source = readFileSync(file, 'utf8'), strings = [...source.matchAll(/\bui\(\s*'((?:[^'\\]|\\.)*)'/g), ...source.matchAll(/new GitError\(\s*'((?:[^'\\]|\\.)*)'/g)]
      .map(m => m[1].replace(/\\n/g, '\n').replace(/\\'/g, "'"));
    const labels = /const LABELS[^{]*\{([\s\S]*?)\};/.exec(source)?.[1];
    if (labels) strings.push(...[...labels.matchAll(/:\s*'([^']*)'/g)].map(m => m[1]));
    for (const text of strings) if (!Object.hasOwn(zh, text)) missing.push(text);
  }
  assert.deepEqual(missing, []);
});


test('Save and resolve is explicit, disabled while markers remain, and carries the bound workspace', async () => {
  const { DiffTab } = await import('../src/client/diff-tab.js');
  const text = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n';
  routes.compare = () => ({ location: { kind: 'local' }, path: 'c.ts', repoPath: 'c.ts', head: { kind: 'text', content: 'ours\n' },
    working: { kind: 'text', content: text, revision: sha(text), size: text.length }, code: 'UU' });
  routes.saveResolve = body => ({ revision: sha(String(body.content)), staged: true });
  routes.status = () => ({ prefix: '', changes: [] });
  await mount(<DiffTab address="dsh-resource://file/session/s1/c.ts" cache={new StatusCache()} />);
  assert.equal(button('Save and resolve').disabled, true);
  await click(button('Accept both'));
  assert.equal(button('Save and resolve').disabled, false);
  await click(button('Save and resolve')); await settle();
  const request = requests.find(r => r.action === 'saveResolve')!;
  assert.deepEqual([request.content, request.revision, request.expectedCwd], ['ours\ntheirs\n', sha(text), '/repo']);
  assert.match(String(request.requestId), /^[a-f0-9-]{36}$/);
  assert.match(container.querySelector('.gv-notes')!.textContent!, /Saved and staged/);
  assert.equal(requests.some(r => r.action === 'save' || r.action === 'stage'), false, 'one explicit combined request');
});

test('slow ordinary and conflict-resolution saves keep newer drafts and update only the submitted baseline', async () => {
  const { DiffTab } = await import('../src/client/diff-tab.js');
  for (const action of ['save', 'saveResolve']) {
    const initial = 'initial\n';
    routes.compare = () => ({ location: { kind: 'local' }, path: 'c.ts', repoPath: 'c.ts', head: { kind: 'text', content: 'base\n' },
      working: { kind: 'text', content: initial, revision: sha(initial), size: initial.length }, code: action === 'saveResolve' ? 'UU' : ' M' });
    let release!: () => void;
    routes[action] = body => new Promise(resolve => { release = () => resolve({ revision: sha(String(body.content)), ...(action === 'saveResolve' ? { staged: true } : {}) }); });
    routes.status = () => ({ prefix: '', changes: [] });
    await mount(<DiffTab address="dsh-resource://file/session/s1/c.ts" cache={new StatusCache()} />);
    const model = fake.diffs.at(-1)!.getModel()!.modified;
    await act(async () => model.setValue('submitted\n'));
    await click(button(action === 'saveResolve' ? 'Save and resolve' : 'Save (⌘/Ctrl+S)')); await settle();
    // Simulate queued editor input arriving while the request is pending.
    await act(async () => model.setValue('newer unsaved edit\n'));
    await act(async () => release()); await settle();
    assert.equal(model.getValue(), 'newer unsaved edit\n');
    assert.equal(button('Save (⌘/Ctrl+S)').disabled, false);
    routes.save = body => ({ revision: sha(String(body.content)) });
    await click(button('Save (⌘/Ctrl+S)')); await settle();
    const next = requests.filter(r => r.action === 'save').at(-1)!;
    assert.equal(next.revision, sha('submitted\n'));
    assert.equal(next.content, 'newer unsaved edit\n');
    await act(async () => root!.unmount()); root = undefined;
  }
});

test('partial save-and-resolve failure explains what happened and retries from the saved revision', async () => {
  const { DiffTab } = await import('../src/client/diff-tab.js');
  routes.compare = () => ({ location: { kind: 'local' }, path: 'c.ts', repoPath: 'c.ts', head: { kind: 'text', content: 'base\n' },
    working: { kind: 'text', content: 'resolved\n', revision: sha('resolved\n'), size: 9 }, code: 'UU' });
  let tries = 0;
  routes.saveResolve = body => ++tries === 1 ? { revision: sha(String(body.content)), staged: false, error: 'index.lock is held' } : { revision: sha(String(body.content)), staged: true };
  routes.status = () => ({ prefix: '', changes: [] });
  await mount(<DiffTab address="dsh-resource://file/session/s1/c.ts" cache={new StatusCache()} />);
  const model = fake.diffs.at(-1)!.getModel()!.modified;
  await act(async () => model.setValue('reviewed\n'));
  await click(button('Save and resolve')); await settle();
  assert.match(container.querySelector('.gv-notes')!.textContent!, /Saved, but not staged: index.lock is held/);
  assert.equal(button('Save and resolve').disabled, false);
  await click(button('Save and resolve')); await settle();
  assert.equal(requests.filter(r => r.action === 'saveResolve')[1].revision, sha('reviewed\n'));
});
