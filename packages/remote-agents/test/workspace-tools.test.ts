import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fixture } from './fakes.js';
import { RemoteAgentsService } from '../src/service.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { WorkspaceFiles } from '../src/workspace-files.js';
import { workspaceTools } from '../src/workspace-tools.js';
import type { ToolHost } from '../src/tools.js';
import type { DshPermission } from '../src/domain.js';

// Answers each workspace operation as the remote shell program would.
const RESPONSES: Record<string, string> = { list: 'ok\n\0', command: 'ok\n0 0 3 0\nran', upload: `ok\n${'a'.repeat(64)} 5\n` };
async function setup(t: TestContext) {
  const f = await fixture(t); await f.service.close();
  const state = { operations: [] as string[], approvals: [] as string[], approval: 'allowed-once', cwd: '/srv/app', switchDuringApproval: false, permission: undefined as DshPermission | undefined };
  const files = new WorkspaceFiles({
    exec: async () => { throw new Error('Not used'); }, start() { throw new Error('Not used'); },
    transfer: async script => { const op = /^dsh_op='(\w+)'/.exec(script)![1]; state.operations.push(op); return Buffer.from(RESPONSES[op]); },
  });
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async id => { assert.equal(id, 'session'); return { hostIds: [f.hostId], cwd: state.cwd }; }, async () => undefined);
  const host: ToolHost = { approval: { request: async value => { state.approvals.push(value.reason!); if (state.switchDuringApproval) state.cwd = '/srv/changed'; return state.approval; } }, userQuestions: { ask: async () => ({}) } };
  const agent = { session: { id: 'session' } };
  const [tool] = workspaceTools(workspace, host, value => { assert.equal(value, agent); return state.permission; });
  return { state, tool, exec: { callId: 'workspace-call', signal: new AbortController().signal, agent } };
}

test('DSH workspace tools use the agent session, ask before commands and reject a switch during approval', async t => {
  const { state, tool, exec } = await setup(t);
  assert.deepEqual(await tool.execute({ op: 'list', path: '.' }, exec), { path: '', entries: [] });
  assert.deepEqual(state.operations, ['list']); assert.equal(state.approvals.length, 0);
  state.approval = 'rejected';
  await assert.rejects(tool.execute({ op: 'command', path: '.', command: 'echo should-not-run' }, exec), /not approved \(rejected\)/);
  assert.deepEqual(state.operations, ['list']); assert.match(state.approvals[0], /Build server:\/srv\/app/);
  state.approval = 'allowed-once'; state.switchDuringApproval = true;
  await assert.rejects(tool.execute({ op: 'command', path: '.', command: 'echo old-workspace' }, exec), /workspace changed/);
  assert.deepEqual(state.operations, ['list']);
  await assert.rejects(tool.execute({ op: 'list', path: '.' }, { ...exec, agent: undefined }), /conversation workspace/);
});

test('the conversation permission decides which workspace changes still ask, as DSH tools do', async t => {
  const { state, tool, exec } = await setup(t);
  // Full access never asks: its approval policy would reject every question.
  state.approval = 'rejected';
  for (const permission of ['danger-full-access', 'auto'] as const) {
    state.permission = permission;
    assert.equal((await tool.execute({ op: 'command', path: '.', command: 'true' }, exec) as { stdout: string }).stdout, 'ran');
    await tool.execute({ op: 'write', path: 'notes.txt', content: 'hello', revision: null }, exec);
  }
  assert.deepEqual(state.approvals, []);
  // Workspace write edits files inside the workspace directly, but a remote command is not sandboxed.
  state.permission = 'workspace-write';
  await tool.execute({ op: 'write', path: 'notes.txt', content: 'hello', revision: null }, exec);
  assert.equal(state.approvals.length, 0);
  await assert.rejects(tool.execute({ op: 'command', path: '.', command: 'true' }, exec), /not approved/);
  assert.equal(state.approvals.length, 1);
  // Read-only and custom permissions ask before every change.
  for (const permission of ['read-only', undefined] as const) {
    state.permission = permission;
    await assert.rejects(tool.execute({ op: 'write', path: 'notes.txt', content: 'hello', revision: null }, exec), /not approved/);
  }
  assert.equal(state.approvals.length, 3);
  assert.deepEqual(state.operations, ['command', 'upload', 'command', 'upload', 'upload']);
});
