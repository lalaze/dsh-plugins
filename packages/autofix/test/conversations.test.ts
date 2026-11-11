import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversations } from '../src/conversations.js';

function dsh(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [], session = { id: 's1' }, agent = { id: 's1' };
  const services: Record<string, unknown> = {
    workspaceController: { async create({ path }: { path: string }) { calls.push(`workspace ${path}`); return { workspace: { workspaceId: 'w1' } }; } },
    sessionController: {
      async create({ workspaceId }: { workspaceId: string }) { calls.push(`session in ${workspaceId}`); return { sessionId: 's1' }; },
      async selectModel(input: { provider: string; model: string; reasoningEffort?: string }) { calls.push(`model ${input.provider}/${input.model}${input.reasoningEffort ? ` ${input.reasoningEffort}` : ''}`); },
      async rename({ title }: { title: string }) { calls.push(`title ${title}`); },
      async resolveAgent(id: string) { return id === 's1' ? { agent } : { error: { message: 'Session not found' } }; },
    },
    sessions: { get: (id: string) => id === 's1' ? session : undefined },
    permissionPresets: { set(target: unknown, preset: string) { assert.equal(target, session); calls.push(`permission ${preset}`); } },
    modelFlow: { version: 1, async start(target: unknown, input: { goal: string }) { assert.equal(target, agent); calls.push(`flow ${input.goal}`); return { done: new Promise(() => {}), stop() {} }; } },
    ...overrides,
  };
  return { calls, conversations: new Conversations(name => services[name]) };
}

test('a task gets its own conversation: workspace, model, title, then the permission its steps run with', async () => {
  const { calls, conversations } = dsh();
  const opened = await conversations.open({ path: '/repo/wt', title: 'bug 1001', model: { provider: 'p', model: 'm', reasoningEffort: 'high' }, permission: 'workspace-write' });
  assert.deepEqual(opened, { workspaceId: 'w1', sessionId: 's1' });
  assert.deepEqual(calls, ['workspace /repo/wt', 'session in w1', 'model p/m high', 'title bug 1001', 'permission workspace-write']);
  await conversations.flow('s1', { goal: 'fix it' });
  assert.equal(calls.at(-1), 'flow fix it');
});

test('what is missing is named', async () => {
  await assert.rejects(dsh({ modelFlow: undefined }).conversations.flow('s1', { goal: 'x' }), /dsh-model-flow/);
  await assert.rejects(dsh().conversations.flow('other', { goal: 'x' }), /could not be opened: Session not found/);
  await assert.rejects(dsh({ workspaceController: undefined }).conversations.open({ path: '/p', title: 't', model: { provider: 'p', model: 'm' }, permission: 'auto' }), /Workspaces is not available/);
});
