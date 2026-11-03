import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteTasks } from '../src/agents/tasks.js';
import { fixture } from './fakes.js';

test('other plugins list, read and steer the remote sessions that have no DSH conversation', async t => {
  const { service, store, remote, request } = await fixture(t);
  const tasks = remoteTasks(service);
  let changes = 0; const off = tasks.subscribe(() => changes++);
  const delegated = request({ prompt: 'Review the API' }), chat = request({ prompt: 'Bound to a main chat' });
  await service.create(delegated, { title: 'Review the API' });
  await service.create(chat, { title: 'Main chat', chat: { sessionId: 'dsh-conversation', route: 'route' } });
  await store.update(state => { state.tasks.find(task => task.id === delegated.id)!.origin = 'dsh'; });
  assert.ok(changes > 0, 'saved changes are announced');

  const listed = await tasks.list();
  assert.deepEqual(listed.map(task => [task.id, task.title, task.delegated, task.host]), [[delegated.id, 'Review the API', true, 'Build server']], 'a main chat\'s session is left out');

  const detail = await tasks.detail(delegated.id);
  assert.equal(detail.task.id, delegated.id); assert.deepEqual(detail.permissions, []);
  assert.deepEqual(detail.timeline?.entries.map(entry => [entry.item.type, entry.item.text]), [['user_message', 'Review the API']]);

  await tasks.send(delegated.id, 'message-from-phone-1', 'Also check the docs');
  await tasks.send(delegated.id, 'message-from-phone-1', 'Also check the docs');
  assert.equal(remote.sends, 1, 'a retried send arrives once');
  assert.equal((await tasks.detail(delegated.id)).timeline?.entries.at(-1)?.item.text, 'Follow-up completed.');

  await assert.rejects(tasks.detail(chat.id), /continues in a DSH conversation/);
  await assert.rejects(tasks.send(chat.id, 'message-from-phone-2', 'Hello'), /continues in a DSH conversation/);
  assert.equal(remote.sends, 1);
  off(); const before = changes;
  await store.update(state => { state.tasks[0].title = 'Renamed'; });
  assert.equal(changes, before, 'unsubscribed');
});
