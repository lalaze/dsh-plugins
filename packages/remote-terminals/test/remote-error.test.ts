import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteError } from '@dsh-plugins/remote-core/domain.js';
import type { RemoteAgentsMachines } from '@dsh-plugins/remote-core/machines.js';
import { createHandler } from '../src/index.js';
import type { Terminals } from '../src/install.js';
import { RemoteMachine } from '../src/worktree-machine.js';

/**
 * Remote Agents' copy of the module, as an installed plugin has one of its own. The tests elsewhere share one copy with
 * it, which is how the first release missed that its errors were not recognized.
 */
const theirs = await import('@dsh-plugins/remote-core/domain.js?remote-agents-copy' as string) as typeof import('@dsh-plugins/remote-core/domain.js');

test('an error made by another plugin\'s copy of RemoteError is recognized, and nothing else is', () => {
  assert.notEqual(theirs.RemoteError, RemoteError, 'two copies of the class');
  const missing = new theirs.RemoteError('Not found', 404);
  assert.ok(missing instanceof RemoteError); assert.equal((missing as RemoteError).status, 404);
  assert.ok(new RemoteError('x') instanceof theirs.RemoteError, 'and the other way round');
  assert.equal(new Error('plain') instanceof RemoteError, false);
  assert.equal(Object.assign(new Error('has a status'), { status: 404 }) instanceof RemoteError, false, 'a status alone is not enough');
  assert.equal(Object.assign(new TypeError('odd'), { status: 'no' }) instanceof RemoteError, false);
  assert.equal((null as unknown) instanceof RemoteError, false);
  // A subclass stays what its own copy made: every RemoteError is not one of it.
  class Narrower extends RemoteError {}
  assert.equal(missing instanceof Narrower, false); assert.ok(new Narrower('n') instanceof Narrower); assert.ok(new Narrower('n') instanceof theirs.RemoteError);
});

test('what Remote Agents refuses keeps its status through this plugin\'s requests', async () => {
  const machines = {
    target: async (sessionId: string) => { if (sessionId !== 'remote') throw new theirs.RemoteError('Select a verified remote workspace first.', 409); return { hostId: 'h', label: 'Box', cwd: '/srv/app' }; },
    createWorkspace: async () => { throw new theirs.RemoteError('Remote host was removed', 409); },
  } as unknown as RemoteAgentsMachines;
  const terminals = { terminal: { shell: '/dsh/terminal/Remote workspace' } } as unknown as Terminals;
  const handler = createHandler(() => ({ terminals, machines }));
  const ask = async (body: unknown) => {
    const response = await handler(new Request('http://dsh.test/api/remote-terminals', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await ask({ action: 'terminalShell', sessionId: 'local' }), { status: 200, body: {} }, 'a conversation outside a remote workspace simply has no remote shell');
  assert.deepEqual(await ask({ action: 'terminalShell', sessionId: 'remote' }), { status: 200, body: { shell: '/dsh/terminal/Remote workspace' } });
  assert.deepEqual(await ask({ action: 'openWorktree', hostId: 'host-box-1', path: '/srv/app' }), { status: 409, body: { error: 'Remote host was removed' } });
});

test('a file that is not on the machine reads as absent to a worktree, though Remote Agents reported it', async () => {
  const files = {
    readAbsolute: async (path: string) => { if (path.endsWith('worktree.json')) throw new theirs.RemoteError('Not found', 404); if (path.endsWith('secret')) throw new theirs.RemoteError('Path is outside the remote workspace', 403); throw new theirs.RemoteError('The SSH host returned an unexpected workspace response', 502); },
    operate: async () => { throw new theirs.RemoteError('Not found', 404); },
  };
  const machine = new RemoteMachine({ browse: async () => ({ path: '/home/me' }) as never, withWorkspace: async (_id, verify, action) => { await verify(); return action(files as never); } }, 'host-box-1');
  assert.equal(await machine.read('/srv/app/.dsh/worktree.json', 1000), undefined);
  assert.equal(await machine.read('/srv/app/secret', 1000), undefined);
  await assert.rejects(machine.read('/srv/app/other', 1000), /unexpected workspace response/, 'a real failure is still one');
  assert.equal(await machine.exists('/srv/app/gone'), false);
});
