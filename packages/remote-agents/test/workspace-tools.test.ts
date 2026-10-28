import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fakes.js';
import { RemoteAgentsService } from '../src/service.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { WorkspaceFiles } from '../src/workspace-files.js';
import { workspaceTools } from '../src/workspace-tools.js';
import type { ToolHost } from '../src/tools.js';

test('DSH workspace tools use the agent session, ask before commands and reject a switch during approval', async t => {
  const f = await fixture(t); await f.service.close(); let operations = 0, approval = 'allowed-once', switchDuringApproval = false, cwd = '/srv/app';
  const files = new WorkspaceFiles({ exec: async () => { operations++; return '{"result":{"entries":[]}}'; }, start() { throw new Error('Not used'); } });
  const agents = new RemoteAgentsService(f.store, host => ({ ...f.remote.backend(host), workspaceFiles: files })); t.after(() => agents.close());
  const workspace = new WorkspaceService(agents, async id => { assert.equal(id, 'session'); return { hostIds: [f.hostId], cwd }; }, async () => undefined);
  const approvals: string[] = [];
  const host: ToolHost = { approval: { request: async value => { approvals.push(value.reason!); if (switchDuringApproval) cwd = '/srv/changed'; return approval; } }, userQuestions: { ask: async () => ({}) } };
  const [tool] = workspaceTools(workspace, host), exec = { callId: 'workspace-call', signal: new AbortController().signal, agent: { session: { id: 'session' } } };
  assert.deepEqual(await tool.execute({ op: 'list', path: '.' }, exec), { entries: [] });
  assert.equal(operations, 1); assert.equal(approvals.length, 0);
  approval = 'rejected';
  await assert.rejects(tool.execute({ op: 'command', path: '.', command: 'echo should-not-run' }, exec), /not approved/);
  assert.equal(operations, 1); assert.match(approvals[0], /Build server:\/srv\/app/);
  approval = 'allowed-once'; switchDuringApproval = true;
  await assert.rejects(tool.execute({ op: 'command', path: '.', command: 'echo old-workspace' }, exec), /workspace changed/);
  assert.equal(operations, 1);
  await assert.rejects(tool.execute({ op: 'list', path: '.' }, { ...exec, agent: undefined }), /conversation workspace/);
});
