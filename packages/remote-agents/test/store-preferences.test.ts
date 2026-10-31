import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';
import { ChatProjects } from '../src/chat/projects.js';
import { Store } from '../src/core/store.js';
import { fixture } from './fakes.js';

for (const initial of [false, true]) test(`concurrent Fast selections preserve request order from ${initial ? 'on' : 'off'}`, async t => {
  const { service, store, path } = await fixture(t), projects = new ChatProjects(service);
  await projects.setFast('other-session', true);
  await projects.setFast('session', initial);
  for (const choices of [[!initial, initial], [!initial, initial, !initial]]) {
    const results = await Promise.all(choices.map(enabled => projects.setFast('session', enabled)));
    assert.deepEqual(results, choices.map(enabled => ({ enabled })));
    assert.equal(store.chatFast('session'), choices.at(-1));
    assert.equal(store.chatFast('other-session'), true, 'other conversations are unchanged');
    const reopened = new Store(path); await reopened.open();
    assert.equal(reopened.chatFast('session'), choices.at(-1), 'the final selection is durable');
    await reopened.close();
    await projects.setFast('session', initial);
  }
});

test('unchanged store updates preserve the file and do not notify listeners', async t => {
  const { store, path } = await fixture(t);
  const before = await stat(path, { bigint: true });
  let notifications = 0;
  store.changeListeners.add(() => { notifications++; });
  await store.update(() => {});
  await store.update(state => { state.hosts = structuredClone(state.hosts); });
  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, before.ino, 'no atomic replacement for an unchanged registry');
  assert.equal(after.mtimeNs, before.mtimeNs, 'no file rewrite');
  assert.equal(notifications, 0);
  await store.update(state => { state.chatFast = ['session']; });
  assert.equal(notifications, 1, 'real changes still publish');
  assert.equal(store.chatFast('session'), true);
});

test('no-op detection runs inside the write queue and retains stale-writer protection', async t => {
  const { store, path } = await fixture(t);
  let notifications = 0;
  store.changeListeners.add(() => { notifications++; });
  const stale = new Store(path); await stale.open();
  await Promise.all([
    store.update(state => { state.chatFast = ['session']; }),
    store.update(state => { state.chatFast = ['session']; }),
    store.update(state => { delete state.chatFast; }),
    store.update(state => { delete state.chatFast; }),
  ]);
  assert.equal(notifications, 2, 'only the enable and disable write');
  assert.equal(store.chatFast('session'), false);
  await store.update(state => { state.chatFast = ['session']; });
  await assert.rejects(stale.update(() => {}), /changed by another DSH instance/);
  await stale.close();
  await assert.rejects(stale.update(() => {}), /state is closed/);
});

test('reselecting the same Fast or reasoning effort does not write or broadcast', async t => {
  const { service, store, path, hostId } = await fixture(t), projects = new ChatProjects(service);
  const [project] = await projects.add({ hostId, cwd: '/srv/project', label: 'Project' });
  const route = `${project.id}/codex/remote-model`;
  await projects.setFast('session', true);
  await projects.setEffort('remote-cli-codex', route, 'high');
  const before = await stat(path, { bigint: true });
  let writes = 0, effortChanges = 0;
  store.changeListeners.add(() => { writes++; });
  const off = projects.onEffortChange(() => { effortChanges++; });
  t.after(off);
  await projects.setFast('session', true);
  await projects.setEffort('remote-cli-codex', route, 'high');
  const after = await stat(path, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(writes, 0);
  assert.equal(effortChanges, 0);
});
