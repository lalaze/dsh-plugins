import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultSettings, SettingsStore, type Bug, type TapdSettings } from '../src/settings.js';
import { itemOf, tapdSource, writeBack, type ItemEvent } from '../src/source.js';

const settings = (change: Partial<TapdSettings> = {}): TapdSettings => ({ ...defaultSettings(), auth: { kind: 'bearer', token: 't' }, owner: 'me', workspaces: [{ id: '100', name: 'Dana' }], ...change });
const bug: Bug = { id: '1001', workspaceId: '100', title: '【活动页】白屏', description: '<p>点充值后白屏</p><img src="/tfl/a.png">', owner: 'me;', status: 'new', labels: ['h5'], module: '活动', priority: 'high' };

test('a TAPD bug becomes an item any runner can read', () => {
  assert.deepEqual(itemOf(bug, settings()), {
    source: 'tapd', id: '100/1001', ref: '1001', title: '【活动页】白屏', body: '点充值后白屏\n [image 1]', url: 'https://www.tapd.cn/100/bugtrace/bugs/view?bug_id=1001',
    project: { id: '100', name: 'Dana' }, status: 'new', priority: 'high', module: '活动', labels: ['h5'], images: 1,
  });
  assert.deepEqual(itemOf({ ...bug, workspaceId: '200', description: '', status: '', priority: '', module: '' }, settings()).project, { id: '200', name: '200' });
});

test('what happened to a bug is written back as the settings say', async () => {
  const review: ItemEvent = { kind: 'review', branch: 'tapd/100/1001', commit: 'abcdef0123456', checks: 2 };
  const accepted: ItemEvent = { kind: 'accepted', baseBranch: 'main', branch: 'tapd/100/1001', commit: 'abcdef0123456', mergeCommit: '1234567890abc' };
  assert.equal(writeBack({ kind: 'started', baseBranch: 'main' }, settings(), true), undefined, 'no in-progress status: the bug is left alone');
  assert.deepEqual(writeBack({ kind: 'started', baseBranch: 'main' }, settings({ inProgressStatus: '处理中' }), true), { status: '处理中' });
  assert.equal(writeBack(review, settings({ commentOnReview: false }), true), undefined);
  assert.equal(writeBack(review, settings(), true)?.comment, 'AI 修复已完成，等待人工验收。\n分支：tapd/100/1001\n提交：abcdef012\n检查：2 项通过');
  assert.match(writeBack(review, settings(), false)!.comment!, /^An AI fix is ready[\s\S]*Checks passed: 2$/);
  assert.deepEqual(writeBack(accepted, settings(), true), { status: 'resolved', comment: '修复已验收，并合并到 main。\n合并提交：123456789' });
  assert.equal(writeBack({ ...accepted, mergeCommit: undefined }, settings(), true)?.comment, '修复已验收，分支 tapd/100/1001 已推送。\n提交：abcdef012');
  assert.throws(() => writeBack(accepted, settings({ doneStatus: '' }), true), /Set the status an accepted bug gets/);

  let current = settings({ auth: { kind: 'bearer', token: '' } });
  const written: unknown[] = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]), asked: string[] = [];
  const source = tapdSource({
    async listBugs() { return [bug]; }, async update(target, change) { written.push([target, change]); },
    async getBug(workspaceId, id) { return workspaceId === '100' && id === '1001' ? bug : undefined; },
    async image(address) { asked.push(address); return { bytes: png, mediaType: 'image/png', extension: 'png' }; },
  }, () => current);
  assert.equal(source.unready?.()?.key, 'Add the access token, your TAPD name and a TAPD project in Settings → TAPD first.');
  current = settings();
  assert.equal(source.unready?.(), undefined);
  assert.deepEqual((await source.fetch!()).map(item => item.id), ['100/1001']);
  await source.report!(itemOf(bug, current), accepted);
  await source.report!(itemOf(bug, current), { kind: 'started', baseBranch: 'main' });
  assert.deepEqual(written, [[{ workspaceId: '100', id: '1001' }, { status: 'resolved', comment: '修复已验收，并合并到 main。\n合并提交：123456789' }]], 'nothing is written for a status that is not configured');
  await assert.rejects(source.report!({ ...itemOf(bug, current), id: 'odd' }, accepted), /not a TAPD bug/);
  // The bug's pictures are read from TAPD when a task needs them.
  assert.deepEqual(await source.image!(itemOf(bug, current), 0), { data: png, mediaType: 'image/png', name: 'tapd-1001-1.png' });
  assert.deepEqual(asked, ['/tfl/a.png']);
  assert.equal(await source.image!(itemOf(bug, current), 1), undefined, 'the description has one picture');
  assert.equal(await source.image!({ ...itemOf(bug, current), id: '100/9' }, 0), undefined, 'a bug TAPD no longer has');
});

test('the token is kept for the owner only, never sent to a page, and an empty one keeps the saved one', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tapd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'dsh-tapd', 'settings.json'), store = new SettingsStore(file);
  await store.open();
  await store.save({ auth: { kind: 'bearer', token: 'secret' }, owner: 'me', workspaces: [{ id: 100, name: 'Dana' }], statuses: ['new', 'new', ' 待处理 '] });
  assert.deepEqual([store.settings.workspaces, store.settings.statuses, store.settings.doneStatus], [[{ id: '100', name: 'Dana' }], ['new', '待处理'], 'resolved']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.save({ ...store.settings, auth: { kind: 'bearer', token: '' }, owner: 'someone' });
  assert.deepEqual([store.settings.auth.token, store.settings.owner], ['secret', 'someone']);
  await store.save({ ...store.settings, auth: { kind: 'basic', user: 'api', token: '' } });
  assert.equal(store.settings.auth.token, '', 'another kind of sign-in does not inherit the token');
  await assert.rejects(store.save({ apiBase: 'ftp://x' }), /must start with http/);
  await assert.rejects(store.save({ workspaces: [{ id: 'abc' }] }), /is a number/);
  const reopened = new SettingsStore(file);
  await reopened.open();
  assert.equal(reopened.settings.owner, 'someone');
  assert.match(await readFile(file, 'utf8'), /"kind": "basic"/);
});
