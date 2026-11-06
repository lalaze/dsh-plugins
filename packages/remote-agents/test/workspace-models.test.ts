import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceDirectory, type Admission, type Directory } from '../src/client/composer/workspace-models.js';

const selection = { provider: 'remote-cli-claude', model: 'machine-one/claude/opus' };
function fixture() {
  const selected: unknown[] = [];
  const snapshot = { current: selection, routable: true, status: 'ready', groups: [
    { id: 'deepseek', models: [{ id: 'deepseek-chat' }] },
    { id: selection.provider, models: [{ id: selection.model }, { id: 'machine-two/claude/opus' }] },
  ] };
  const directory: Directory = { store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    load: async () => snapshot, select: async model => { selected.push(model); return { ok: true }; } };
  return { directory, snapshot, selected };
}

test('each workspace filters the shared catalog without changing other sessions or ordinary models', async () => {
  const { directory, snapshot } = fixture();
  const first = workspaceDirectory(directory, { key: () => 'one', check: async () => ({ hostIds: ['machine-one'] }) });
  const second = workspaceDirectory(directory, { key: () => 'two', check: async () => ({ hostIds: ['machine-two'] }) });
  assert.equal(first.view.store.getSnapshot().groups.length, 1, 'unverified remote models are hidden');
  await Promise.all([first.view.load(), second.view.load()]);
  assert.deepEqual(first.view.store.getSnapshot().groups[1].models, [{ id: selection.model }]);
  assert.deepEqual(second.view.store.getSnapshot().groups[1].models, [{ id: 'machine-two/claude/opus' }]);
  assert.equal(second.view.store.getSnapshot().current, null, 'the trigger cannot show a previous machine');
  assert.equal(second.view.store.getSnapshot().routable, false);
  assert.equal(snapshot.groups[1].models.length, 2);
  assert.equal(first.view.store.getSnapshot(), first.view.store.getSnapshot(), 'stable React store snapshot');
  first.dispose(); second.dispose();
});

test('workspace changes immediately revoke admission and discard stale responses including a pending selection', async () => {
  const { directory, selected } = fixture();
  let key = 'one'; const requests: { signal: AbortSignal; resolve(value: Admission): void }[] = [];
  const wrapped = workspaceDirectory(directory, { key: () => key, check: signal => new Promise(resolve => requests.push({ signal, resolve })) });
  const loading = wrapped.view.load(); requests[0].resolve({ hostIds: ['machine-one'] }); await loading;
  const selecting = wrapped.view.select(selection);
  key = 'two'; wrapped.changed();
  assert.equal(wrapped.view.store.getSnapshot().current, null);
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({ hostIds: ['machine-one'] });
  assert.equal((await selecting as { ok: boolean }).ok, false);
  requests[2].resolve({ hostIds: ['machine-two'] }); await wrapped.view.load();
  assert.equal(selected.length, 0);
  assert.deepEqual(wrapped.view.store.getSnapshot().groups[1].models, [{ id: 'machine-two/claude/opus' }]);
  wrapped.dispose();
});

test('selection rechecks admission, preserves ordinary selections and fails closed on errors and teardown', async () => {
  const { directory, selected } = fixture(); let valid = true;
  const wrapped = workspaceDirectory(directory, { key: () => 'one', check: async () => {
    if (!valid) throw new Error('offline'); return { hostIds: ['machine-one'] };
  } });
  await wrapped.view.load(); valid = false;
  assert.equal((await wrapped.view.select(selection) as { ok: boolean }).ok, false);
  assert.equal(wrapped.view.store.getSnapshot().groups.length, 1);
  assert.deepEqual(await wrapped.view.select({ provider: 'deepseek', model: 'deepseek-chat' }), { ok: true });
  assert.equal(selected.length, 1);
  wrapped.dispose();
  assert.equal(wrapped.view.store.getSnapshot(), directory.store.getSnapshot(), 'disabling the plugin restores the native catalog view');
  assert.equal((await wrapped.view.select(selection) as { ok: boolean }).ok, false);
});

test('successful explicit thinking choices are remembered immediately without a conversation turn', async () => {
  const { directory, snapshot, selected } = fixture(), remembered: unknown[] = [];
  const wrapped = workspaceDirectory(directory, { key: () => 'one', check: async () => ({ hostIds: ['machine-one'] }),
    remember: async choice => { remembered.push(choice); } });
  await wrapped.view.load();
  wrapped.view.store.getSnapshot(); await wrapped.refresh();
  assert.deepEqual(remembered, [], 'loading or restoring a current selection is not a user choice');
  const high = { ...selection, reasoningEffort: 'high' };
  assert.deepEqual(await wrapped.view.select(high), { ok: true });
  assert.deepEqual(remembered, [high]); assert.deepEqual(selected, [high]);
  assert.equal(snapshot.current, selection, 'the host remains the owner of the current selection');
  await wrapped.view.select(selection);
  await wrapped.view.select({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
  assert.deepEqual(remembered, [high], 'ordinary models and omitted efforts do not set remote defaults');
  wrapped.dispose();
});

test('failed selections and rejected workspace admissions never change the remembered effort', async () => {
  const { directory } = fixture(), remembered: unknown[] = [];
  const failure = { ok: false, error: { code: 'selection-failed', message: 'Not saved' } };
  directory.select = async () => failure;
  let allowed = true;
  const wrapped = workspaceDirectory(directory, { key: () => 'one', check: async () => ({ hostIds: allowed ? ['machine-one'] : [] }),
    remember: async choice => { remembered.push(choice); } });
  const high = { ...selection, reasoningEffort: 'high' };
  assert.equal(await wrapped.view.select(high), failure);
  allowed = false;
  assert.equal((await wrapped.view.select(high) as { ok: boolean }).ok, false);
  assert.deepEqual(remembered, []);
  wrapped.dispose();
});

test('a preference save failure is visible and retrying the same choice saves it', async () => {
  const { directory } = fixture(); let offline = true, saves = 0, updates = 0;
  const wrapped = workspaceDirectory(directory, { key: () => 'one', check: async () => ({ hostIds: ['machine-one'] }),
    remember: async () => { if (offline) throw new Error('offline'); saves++; } });
  const off = wrapped.view.store.subscribe(() => updates++), high = { ...selection, reasoningEffort: 'high' };
  assert.equal((await wrapped.view.select(high) as { ok: boolean }).ok, false);
  assert.match(wrapped.view.store.getSnapshot().error!, /Failed to save the thinking level/);
  assert.equal(wrapped.view.store.getSnapshot(), wrapped.view.store.getSnapshot());
  offline = false;
  assert.deepEqual(await wrapped.view.select(high), { ok: true });
  assert.equal(saves, 1); assert.equal(wrapped.view.store.getSnapshot().error, undefined);
  assert.ok(updates > 0); off(); wrapped.dispose();
});

for (const change of ['workspace', 'dispose'] as const) test(`a ${change} change during the host selection does not save a stale preference`, async () => {
  const { directory } = fixture(), remembered: unknown[] = [];
  let key = 'one', started!: () => void, complete!: (result: unknown) => void;
  const selecting = new Promise<void>(resolve => { started = resolve; });
  directory.select = async () => { started(); return new Promise(resolve => { complete = resolve; }); };
  const wrapped = workspaceDirectory(directory, { key: () => key, check: async () => ({ hostIds: ['machine-one'] }),
    remember: async choice => { remembered.push(choice); } });
  const pending = wrapped.view.select({ ...selection, reasoningEffort: 'high' });
  await selecting;
  if (change === 'workspace') { key = 'two'; wrapped.changed(); } else wrapped.dispose();
  complete({ ok: true }); await pending;
  assert.deepEqual(remembered, []); wrapped.dispose();
});

/** A new conversation in a workspace whose machine cannot run the model it inherited. */
function inherited(current: { provider: string; model: string; reasoningEffort?: string }, hostIds: string[], groups = [
  { id: 'deepseek', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] },
  { id: 'remote-cli-claude', models: [{ id: 'machine-one/claude/opus' }, { id: 'machine-two/claude/haiku' }, { id: 'machine-two/claude/opus' }] },
  { id: 'remote-cli-codex', models: [{ id: 'machine-two/codex/gpt' }] },
]) {
  const adopted: unknown[] = [];
  const listeners = new Set<() => void>();
  const state = { snapshot: { current, routable: true, status: 'ready', groups } };
  const directory: Directory = { store: { getSnapshot: () => state.snapshot, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    load: async () => state.snapshot, select: async () => ({ ok: true }) };
  const options = { key: () => 'workspace', check: async () => ({ hostIds }), blank: () => true,
    adopt: async (selection: unknown) => { adopted.push(selection); } };
  return { directory, options, adopted, state, tell: () => { for (const listener of listeners) listener(); } };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 5));
const opus = { provider: 'remote-cli-claude', model: 'machine-one/claude/opus', reasoningEffort: 'high' };

test('a new conversation in a local workspace takes the last local model instead of a remote one it cannot run', async () => {
  const { directory, options, adopted } = inherited(opus, []);
  const wrapped = workspaceDirectory(directory, { ...options, lastLocal: () => ({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' }) });
  await wrapped.view.load(); await settled();
  assert.deepEqual(adopted, [{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' }]);
  wrapped.dispose();
});

test('with no usable last local model it takes the first local one, and never a model the catalog dropped', async () => {
  const { directory, options, adopted } = inherited(opus, []);
  const wrapped = workspaceDirectory(directory, { ...options, lastLocal: () => ({ provider: 'gone', model: 'gone' }) });
  await wrapped.view.load(); await settled();
  assert.deepEqual(adopted, [{ provider: 'deepseek', model: 'deepseek-chat' }]);
  wrapped.dispose();
});

test('on another machine it takes the same CLI and model there, keeping the thinking level', async () => {
  const { directory, options, adopted } = inherited(opus, ['machine-two']);
  const wrapped = workspaceDirectory(directory, options);
  await wrapped.view.load(); await settled();
  assert.deepEqual(adopted, [{ provider: 'remote-cli-claude', model: 'machine-two/claude/opus', reasoningEffort: 'high' }]);
  wrapped.dispose();
});

test('on another machine without that model it takes that CLI’s first, then any CLI there', async () => {
  const sonnet = inherited({ provider: 'remote-cli-claude', model: 'machine-one/claude/sonnet' }, ['machine-two']);
  const first = workspaceDirectory(sonnet.directory, sonnet.options);
  await first.view.load(); await settled();
  assert.deepEqual(sonnet.adopted, [{ provider: 'remote-cli-claude', model: 'machine-two/claude/haiku' }]);
  first.dispose();
  const grok = inherited({ provider: 'remote-cli-grok', model: 'machine-one/grok/fast' }, ['machine-two']);
  const second = workspaceDirectory(grok.directory, grok.options);
  await second.view.load(); await settled();
  assert.deepEqual(grok.adopted, [{ provider: 'remote-cli-claude', model: 'machine-two/claude/haiku' }]);
  second.dispose();
});

test('a conversation that has started, or a model its machine can run, is left alone', async () => {
  const started = inherited(opus, []);
  const first = workspaceDirectory(started.directory, { ...started.options, blank: () => false });
  await first.view.load(); await settled();
  assert.deepEqual(started.adopted, []);
  assert.equal(first.view.store.getSnapshot().current, null, 'it still asks for a model rather than choosing one');
  first.dispose();
  const allowed = inherited(opus, ['machine-one']);
  const second = workspaceDirectory(allowed.directory, allowed.options);
  await second.view.load(); await settled();
  assert.deepEqual(allowed.adopted, []);
  second.dispose();
});

test('it tries once per inherited model, also when that fails or nothing fits, and waits for the catalog', async () => {
  const failing = inherited(opus, []);
  let tries = 0;
  const first = workspaceDirectory(failing.directory, { ...failing.options, adopt: async () => { tries++; throw new Error('refused'); } });
  await first.view.load(); await settled();
  failing.tell(); failing.tell(); await settled();
  assert.equal(tries, 1);
  first.dispose();
  const empty = inherited(opus, [], []);
  const second = workspaceDirectory(empty.directory, empty.options);
  await second.view.load(); await settled();
  assert.deepEqual(empty.adopted, []);
  empty.state.snapshot = { ...empty.state.snapshot, groups: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }] };
  empty.tell(); await settled();
  assert.deepEqual(empty.adopted, [{ provider: 'deepseek', model: 'deepseek-chat' }], 'a catalog that arrives later is used');
  second.dispose();
});

test('a local model the user picks becomes the next fallback; a remote one does not', async () => {
  const { directory, options } = inherited({ provider: 'deepseek', model: 'deepseek-chat' }, ['machine-two']);
  const remembered: unknown[] = [];
  const wrapped = workspaceDirectory(directory, { ...options, rememberLocal: selection => { remembered.push(selection); } });
  await wrapped.view.load();
  await wrapped.view.select({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' });
  await wrapped.view.select({ provider: 'remote-cli-claude', model: 'machine-two/claude/opus' });
  assert.deepEqual(remembered, [{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' }]);
  wrapped.dispose();
});
