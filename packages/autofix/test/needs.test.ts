import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingPlugins } from '../src/needs.js';
import { AutofixService, Sources } from '../src/service.js';

const running = (...names: string[]) => (name: string) => names.includes(name) ? {} : undefined;

test('the plugins Autofix works through are known by the services they provide', () => {
  assert.deepEqual(missingPlugins(running()), ['dsh-remote-agents', 'dsh-remote-terminals', 'dsh-model-flow']);
  // The machines without the worktrees: only dsh-remote-terminals is missing.
  assert.deepEqual(missingPlugins(running('remoteAgentsMachines')), ['dsh-remote-terminals', 'dsh-model-flow']);
  assert.deepEqual(missingPlugins(running('remoteAgentsMachines', 'remoteAgentsWorktrees')), ['dsh-model-flow']);
  // A dsh-remote-agents from before the split provided the worktrees itself.
  assert.deepEqual(missingPlugins(running('remoteAgentsWorktrees', 'modelFlow')), []);
  assert.deepEqual(missingPlugins(running('remoteAgentsMachines', 'remoteAgentsWorktrees', 'modelFlow')), []);
  // A lookup that throws for a name it does not know is a missing service, not a failure.
  assert.deepEqual(missingPlugins(name => { if (name !== 'modelFlow') throw new Error('unknown service'); return {}; }), ['dsh-remote-agents', 'dsh-remote-terminals']);
});

test('the state the settings page reads says what is missing right now', () => {
  let missing = ['dsh-model-flow'];
  const never = async () => { throw new Error('not used'); };
  const store = { settings: { routes: [], run: {} }, fetch: {}, pool: {}, tasks: {} };
  const service = new AutofixService({ store: store as never, tasks: { running: () => false } as never, sources: new Sources(), workplaces: { projects: never, inspect: never, machine: never }, folders: { add: never, repository: never }, needs: () => missing });
  assert.deepEqual(service.state().needs, ['dsh-model-flow']);
  missing = [];
  assert.deepEqual(service.state().needs, []);
  // A host that does not say is one where nothing is known to be missing.
  const silent = new AutofixService({ store: store as never, tasks: { running: () => false } as never, sources: new Sources(), workplaces: { projects: never, inspect: never, machine: never }, folders: { add: never, repository: never } });
  assert.deepEqual(silent.state().needs, []);
});
