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
import { setSessions, type SessionSummary } from '../src/client/sessions.js';
import { StatusCache, statusLetter } from '../src/client/status.js';
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
test('the status cache refreshes a folder through a conversation working in it and reports changes once', async () => {
  assert.deepEqual(['??', 'UU', ' D', 'R ', 'A ', ' M'].map(statusLetter), ['U', 'C', 'D', 'R', 'A', 'M']);
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

/** DSH's client context as the plugin uses it: services, effects, slots and the locale service of the ported panel. */
function fakeContext(services: Record<string, unknown>, slots: ReturnType<typeof fakeSlots>) {
  const disposers: (() => void)[] = [];
  const ctx = {
    get: (name: string) => services[name], slots,
    effect: (factory: () => (() => void) | void) => { const off = factory(); if (off) disposers.push(off); },
    inject: (names: string[], factory: (scoped: unknown) => void) => { if (names.every(name => services[name])) factory(ctx); },
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key: string) => key },
  };
  return { ctx, dispose: () => { for (const off of disposers.reverse()) off(); } };
}
function fakeSlots() {
  type Entry = { component: React.FC<any>; options: Record<string, unknown> };
  const lists = new Map<string, Entry[]>(), listeners = new Map<string, Set<() => void>>();
  const notify = (key: string) => queueMicrotask(() => { for (const listener of [...listeners.get(key) ?? []]) listener(); });
  return {
    entries: (key: string) => lists.get(key) ?? [],
    subscribe: (key: string, listener: () => void) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(listener); return () => { listeners.get(key)!.delete(listener); };
    },
    register: (spec: Record<string, unknown>, component: React.FC<any>) => {
      const { name, ...options } = spec, key = String(name), entry = { component, options };
      lists.set(key, [...lists.get(key) ?? [], entry]); notify(key);
      return () => { lists.set(key, (lists.get(key) ?? []).filter(e => e !== entry)); notify(key); };
    },
    inject: (_name: string, factory: () => unknown) => factory(),
  };
}

test('while dsh-git-panel is installed, its tab shows this panel in every conversation, with one tab', async () => {
  const { takeOverGitPanel, GIT_PANEL_VIEW } = await import('../src/client/takeover.js');
  const slots = fakeSlots(), present: boolean[] = [];
  const Theirs: React.FC<{ sessionId?: string }> = ({ sessionId }) => <p>theirs {sessionId}</p>;
  const Ours: React.FC<{ sessionId?: string }> = ({ sessionId }) => <p>ours {sessionId}</p>;
  const off = takeOverGitPanel(slots, 'conversation.view', entry => entry.options.id === GIT_PANEL_VIEW, Ours, value => present.push(value));
  const disposeTheirs = slots.register({ name: 'conversation.view', id: GIT_PANEL_VIEW, order: 30 }, Theirs);
  await settle();
  // DSH lists every entry as a tab, so the view keeps its single entry.
  const [entry] = slots.entries('conversation.view');
  assert.equal(slots.entries('conversation.view').length, 1);
  assert.notEqual(entry.component, Theirs);
  assert.deepEqual(present, [true]);
  const View = entry.component;
  await mount(<><View sessionId="s1" /><View sessionId="s2" /></>);
  assert.deepEqual([...container.querySelectorAll('p')].map(p => p.textContent), ['ours s1', 'ours s2']);
  off();
  assert.equal(entry.component, Theirs, 'gives the entry back its component');
  disposeTheirs();
});

test('the panel registers its tab, sidebar page, marker and settings, and steps aside while dsh-git-panel is installed', async () => {
  const client = await import('../src/client/index.js');
  const { GIT_PANEL_PILL, GIT_PANEL_TAB, GIT_PANEL_VIEW } = await import('../src/client/takeover.js');
  const slots = fakeSlots(), kinds = new Set<string>();
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } },
    sidebarRight: { openResource: () => {} },
    sidebarRightTabs: { register: (definition: { kind: string }) => { kinds.add(definition.kind); return () => { kinds.delete(definition.kind); }; } },
  };
  const { ctx, dispose } = fakeContext(services, slots);
  client.apply(ctx as never);
  const keys = (slot: string) => slots.entries(slot).map(e => String(e.options.key ?? e.options.id)).sort();
  assert.deepEqual([...kinds].sort(), [client.DIFF_KIND, client.GIT_KIND]);
  assert.deepEqual(keys('conversation.view'), ['git-view']);
  assert.deepEqual(keys('conversation.input.left'), ['git-view-pill']);
  assert.deepEqual(keys('plugins.bundle.config'), ['dsh-git-view']);
  assert.deepEqual(keys('sidebar.right.pane.tab'), [client.DIFF_KIND, client.GIT_KIND].sort());
  // dsh-git-panel's entries arrive: they show this panel, and this plugin's own leave.
  const Theirs: React.FC = () => null;
  const off = [slots.register({ name: 'conversation.view', id: GIT_PANEL_VIEW }, Theirs), slots.register({ name: 'sidebar.right.pane.tab', key: GIT_PANEL_TAB }, Theirs),
    slots.register({ name: 'conversation.input.left', id: GIT_PANEL_PILL }, Theirs)];
  await settle();
  assert.deepEqual(keys('conversation.view'), [GIT_PANEL_VIEW]);
  assert.deepEqual(keys('conversation.input.left'), [GIT_PANEL_PILL]);
  assert.deepEqual([...kinds], [client.DIFF_KIND]);
  for (const slot of ['conversation.view', 'sidebar.right.pane.tab', 'conversation.input.left']) {
    assert.ok(slots.entries(slot).every(e => e.component !== Theirs), `${slot} shows this panel`);
  }
  for (const remove of off) remove();
  await settle();
  assert.deepEqual(keys('conversation.view'), ['git-view']);
  assert.deepEqual([...kinds].sort(), [client.DIFF_KIND, client.GIT_KIND]);
  dispose();
});

test('the panel’s requests go to this plugin’s route with its client header and come back in the panel’s envelope', async () => {
  const { gitPanelRemoteOf } = await import('../src/gp/client/rpc.js');
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ ok: true, value: { ok: true, value: { kind: 'branches' } } });
  };
  const remote = gitPanelRemoteOf({ get: () => undefined } as never);
  assert.deepEqual(await remote.query({ sessionId: 's1', query: { kind: 'branches' } } as never), { ok: true, value: { kind: 'branches' } });
  assert.deepEqual(sent, [{ url: '/api/git-view/gp', headers: { 'X-DSH-Git-View': '1', 'content-type': 'application/json' }, body: { method: 'query', request: { sessionId: 's1', query: { kind: 'branches' } } } }]);
  (globalThis as { fetch: unknown }).fetch = async () => Response.json({ ok: false, error: { code: 'git-unavailable', message: 'down' } });
  assert.deepEqual(await remote.snapshot({ sessionId: 's1' }), { ok: false, error: { code: 'git-unavailable', message: 'down' } });
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
  const fake = fakeSlots(), { ctx, dispose } = fakeContext(services, fake);
  client.apply(ctx as never);
  await settle();
  for (const name of ['conversation.view', 'sidebar.right.pane.tab', 'sidebar.right.tab.document', 'conversation.input.left']) slots.push(...fake.entries(name).map(e => String(e.options.key ?? e.options.id)));
  assert.deepEqual(definitions.map(d => d.kind), ['git-view/git', 'git-view/diff']);
  assert.equal((definitions[0].guide as { id: string }[])[0].id, 'git-view');
  assert.deepEqual(slots, ['git-view', 'git-view/git', 'git-view/diff', 'git-view/preview', 'git-view-pill']);
  // Only beside DSH's own viewers, in their band, so it never becomes the viewer a file opens with.
  assert.deepEqual(previews.map(p => [p.id, p.priority, p.extensions]), [['git-view/preview', 'builtin', ['ts', 'md']]]);
  const canOpen = definitions[1].canOpen as (address: string) => boolean;
  assert.equal(canOpen('dsh-resource://file/session/s1/src/a.ts'), true);
  assert.equal(canOpen('dsh-resource://file/session/s1/logo.png'), false, 'images keep DSH’s preview');
  assert.equal(canOpen('dsh-resource://file/session/s1/README.md'), false, 'unchanged files keep their viewer');
  dispose();
});

test('explicit diff and ordinary viewers use the public navigator, not kind-dropping tab actions', async () => {
  const client = await import('../src/client/index.js');
  const opened: unknown[] = [];
  const sidebar = { openResource(address: string, options?: Record<string, unknown>) {
    assert.equal(this, sidebar, 'the public service retains its method receiver'); opened.push([address, options]);
  } };
  const services: Record<string, unknown> = {
    sessions: { list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { cwd: '/repo', retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    sidebarRight: sidebar,
    sidebarRightTabs: { register: () => () => {}, candidates: () => [{ kind: client.DIFF_KIND }, { kind: 'text' }] },
  };
  const slots = fakeSlots(), { ctx, dispose } = fakeContext(services, slots);
  const component = (key: string) => slots.entries('sidebar.right.pane.tab').find(e => e.options.key === key)!.component;
  routes.status = () => ({ prefix: '', changes: [{ code: ' M', path: 'src/a.ts', local: 'src/a.ts' }] });
  routes.overview = () => overview();
  routes.compare = () => ({ location: { kind: 'local' }, path: 'src/a.ts', repoPath: 'src/a.ts', code: ' M',
    head: { kind: 'text', content: 'before\n' }, working: { kind: 'text', content: 'after\n', revision: sha('after\n'), size: 6 } });
  const address = 'dsh-resource://file/session/s1/src/a.ts';
  // Real DSH Tab actions strip `kind`; using this path would silently reopen the default diff.
  const useTabInfo = () => ({ tab: { navigation: { address }, actions: { openResource: () => assert.fail('tab action loses explicit kind') } } });
  client.apply(ctx as never);
  try {
    const Diff = component(client.DIFF_KIND);
    await mount(<Diff sessionId="s1" useTabInfo={useTabInfo} />);
    await click(button('Open the file'));
    assert.deepEqual(opened.at(-1), [address, { kind: 'text' }]);
  } finally {
    await act(async () => root?.unmount()); root = undefined;
    dispose();
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
