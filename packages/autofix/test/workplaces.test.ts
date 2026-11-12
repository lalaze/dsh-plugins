import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Failure } from '../src/domain.js';
import { Workplaces } from '../src/workplaces.js';

type JobState = 'running' | 'failed' | 'done';
/** dsh-remote-terminals' worktree service, as far as removing a worktree asks it. */
function service(check: { dirty: number; unpushed: number | null }, states: JobState[], error?: { key: string; values?: Record<string, string> },
  warnings: { key: string; values?: Record<string, string> }[] = [{ key: 'Teardown was skipped' }, { key: 'Branch {branch} was kept because it is not merged', values: { branch: 'fix/1' } }]) {
  const calls: unknown[] = [];
  let reads = 0;
  const job = () => { const state = states[Math.min(reads++, states.length - 1)]; return { id: 'j1', state, log: '', actions: [], ...(state === 'failed' && error ? { error } : {}), ...(state === 'done' ? { result: { branch: 'fix/1', worktree: '/w/fix-1', warnings } } : {}) }; };
  return { calls, worktrees: {
    version: 1,
    async archiveCheck(path: string, worktree: string) { calls.push(['check', path, worktree]); return { branch: 'fix/1', mergedInto: null, teardown: [], workspaces: [], ...check }; },
    archive(request: unknown) { calls.push(['archive', request]); return { id: 'j1', state: 'running', log: '', actions: [] }; },
    job,
    async act(id: string, action: string) { calls.push(['act', id, action]); return job(); },
  } };
}
const said = (error: unknown) => error instanceof Failure ? [error.said.key, error.said.values, error.said.detail] : [String(error)];

test('a worktree is removed once nothing in it exists only there', async () => {
  const fine = service({ dirty: 0, unpushed: 0 }, ['running', 'running', 'done']);
  const places = new Workplaces(name => name === 'remoteAgentsWorktrees' ? fine.worktrees : undefined, 1);
  assert.deepEqual(await places.remove({ project: '/p', worktree: '/w/fix-1' }, new AbortController().signal), { warnings: ['Teardown was skipped'], kept: ['Branch fix/1 was kept because it is not merged'] });
  assert.deepEqual(fine.calls, [['check', '/p', '/w/fix-1'], ['archive', { path: '/p', worktree: '/w/fix-1' }]], 'the branch stays unless it is asked for');
  // Asked to take the branch along: the answer says whether it went, and why not.
  const asked = service({ dirty: 0, unpushed: 0 }, ['done']);
  assert.deepEqual(await new Workplaces(() => asked.worktrees, 1).remove({ project: '/p', worktree: '/w/fix-1', deleteBranch: true }, new AbortController().signal), { warnings: ['Teardown was skipped'], kept: ['Branch fix/1 was kept because it is not merged'], branch: 'kept' });
  assert.deepEqual(asked.calls.at(-1), ['archive', { path: '/p', worktree: '/w/fix-1', deleteBranch: true }]);
  const merged = service({ dirty: 0, unpushed: 0 }, ['done'], undefined, []);
  assert.deepEqual(await new Workplaces(() => merged.worktrees, 1).remove({ project: '/p', worktree: '/w/fix-1', deleteBranch: true }, new AbortController().signal), { warnings: [], kept: [], branch: 'deleted' });

  for (const [check, key, values] of [
    [{ dirty: 2, unpushed: 0 }, 'The workspace has {count} files that are not committed. Commit them or throw them away first, or archive the workspace from the sidebar.', { count: '2' }],
    [{ dirty: 0, unpushed: 3 }, 'The workspace has {count} commits that are not pushed. Push them first, or archive the workspace from the sidebar.', { count: '3' }],
    [{ dirty: 0, unpushed: null }, 'Git could not tell whether everything in the workspace is pushed. Archive the workspace from the sidebar if it can go.', undefined],
  ] as const) {
    const kept = service(check, ['done']);
    await assert.rejects(new Workplaces(() => kept.worktrees, 1).remove({ project: '/p', worktree: '/w/fix-1' }, new AbortController().signal), error => { assert.deepEqual(said(error), [key, values, undefined]); return true; });
    assert.equal(kept.calls.some(call => (call as unknown[])[0] === 'archive'), false, 'nothing was removed');
  }
});

test('a removal that fails or is stopped says so, and an older worktree service is named', async () => {
  const failing = service({ dirty: 0, unpushed: 0 }, ['running', 'failed'], { key: 'Teardown command failed with exit code {code}', values: { code: '2' } });
  await assert.rejects(new Workplaces(() => failing.worktrees, 1).remove({ project: '/p', worktree: '/w' }, new AbortController().signal), error => { assert.deepEqual(said(error), ['The workspace could not be removed', undefined, 'Teardown command failed with exit code 2']); return true; });
  assert.equal(failing.calls.some(call => (call as unknown[])[0] === 'act'), false, 'a failed teardown is not skipped for the person');

  const slow = service({ dirty: 0, unpushed: 0 }, ['running']), controller = new AbortController();
  const pending = new Workplaces(() => slow.worktrees, 1).remove({ project: '/p', worktree: '/w' }, controller.signal);
  setTimeout(() => { slow.worktrees.job = () => ({ id: 'j1', state: 'failed', log: '', actions: ['retry'], error: { key: 'Stopped' } }) as never; controller.abort(); }, 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(slow.calls.at(-1), ['act', 'j1', 'cancel']);

  const old = { version: 1, job: () => undefined, act: async () => undefined };
  await assert.rejects(new Workplaces(() => old, 1).remove({ project: '/p', worktree: '/w' }, new AbortController().signal), /Removing a workspace needs a newer dsh-remote-terminals/);
});
