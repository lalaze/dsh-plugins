import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render, type Item } from '../src/domain.js';
import { addedLines, blocked, changedFiles, chooseScript, commands, touched, warnings } from '../src/gate.js';
import { ordered, prefixKey, projectKey, refresh, suggest, titlePrefix, type Pool } from '../src/pool.js';

const bug = (id: string, title: string, source = 'tapd'): Item => ({ source, id: `100/${id}`, ref: id, title, body: '', project: { id: '100', name: 'Dana' }, labels: [] });

test('a fetch adds new bugs, keeps what a person chose, and marks only that source\'s missing bugs stale', () => {
  let pool: Pool = {}, added: number;
  ({ pool, added } = refresh(pool, 'tapd', [bug('1', '【活动页】白屏'), bug('2', 'H5: 按钮错位')], 1000));
  assert.equal(added, 2);
  ({ pool } = refresh(pool, 'sentry', [bug('9', 'TypeError in pay', 'sentry')], 1500, false));
  pool['tapd:100/1'] = { ...pool['tapd:100/1'], assignment: { routeId: 'dana-web', branch: 'main', package: 'packages/act' } };
  pool['tapd:100/2'] = { ...pool['tapd:100/2'], dismissed: true };
  ({ pool, added } = refresh(pool, 'tapd', [bug('1', '【活动页】白屏（已补充）'), bug('3', '【活动页】倒计时不对'), bug('8', 'not tapd\'s', 'other')], 2000));
  assert.equal(added, 1, 'an item of another source is not this source\'s to hand in');
  const first = pool['tapd:100/1'];
  assert.deepEqual([first.item.title, first.firstSeen, first.lastSeen, first.assignment?.routeId], ['【活动页】白屏（已补充）', 1000, 2000, 'dana-web']);
  assert.deepEqual([pool['tapd:100/2'].stale, pool['tapd:100/2'].dismissed], [true, true]);
  assert.equal(pool['sentry:100/9'].stale, undefined, 'another source\'s bugs are not judged by this fetch');
  assert.deepEqual(ordered(pool).map(item => item.key), ['tapd:100/3', 'sentry:100/9', 'tapd:100/1', 'tapd:100/2']);
  ({ pool } = refresh(pool, 'tapd', [bug('2', 'H5: 按钮错位')], 3000));
  assert.equal(pool['tapd:100/2'].stale, undefined, 'back among the open bugs');
  ({ pool } = refresh(pool, 'sentry', [], 4000, false));
  assert.equal(pool['sentry:100/9'].stale, undefined, 'a source that hands bugs in says nothing about the rest');
});

test('a bug goes where bugs like it went: the same title prefix, then what accepted fixes taught', () => {
  assert.deepEqual(['【活动页】白屏', '[H5] x', 'H5: 按钮', '支付-报错', '没有前缀', '【】x'].map(titlePrefix), ['【活动页】', '[H5]', 'H5', '支付', undefined, undefined]);
  const { pool } = refresh({}, 'tapd', [bug('1', '【活动页】白屏'), bug('2', '【活动页】倒计时'), bug('3', '【后台】列表')], 1);
  const first = { routeId: 'dana-web', branch: 'main', package: 'packages/act' };
  pool['tapd:100/1'].assignment = first;
  assert.deepEqual(suggest(pool, bug('7', '【活动页】新的')), first);
  assert.equal(suggest(pool, bug('7', '【活动页】新的', 'jira')), undefined, 'another source\'s prefixes are its own');
  assert.equal(suggest(pool, bug('7', '【后台】新的')), undefined);
  const memory = { 'prefix:tapd:【后台】': { routeId: 'admin', branch: 'master' }, 'project:tapd:100': { routeId: 'dana-web', branch: 'main' } };
  assert.deepEqual(suggest(pool, bug('7', '【后台】新的'), memory), { routeId: 'admin', branch: 'master' }, 'the prefix, remembered from accepted fixes');
  assert.deepEqual(suggest(pool, bug('7', '没有前缀'), memory), { routeId: 'dana-web', branch: 'main' }, 'then the source\'s project');
  assert.deepEqual([prefixKey(bug('7', '【后台】x')), projectKey(bug('7', 'x'))], ['prefix:tapd:【后台】', 'project:tapd:100']);
  pool['tapd:100/2'].assignment = { ...first, branch: 'release' };
  assert.equal(suggest(pool, bug('7', '【活动页】新的'), memory), undefined, 'two answers for one prefix is no answer');
});

test('nothing sensitive is committed', () => {
  assert.deepEqual(changedFiles(' M src/a.ts\0?? new file.txt\0R  src/new.ts\0src/old.ts\0'), ['src/a.ts', 'new file.txt', 'src/new.ts']);
  assert.match(render(blocked([], '')!), /no change/);
  assert.match(render(blocked(['src/a.ts', 'config/.env.production'], '')!), /sensitive file was changed: config\/\.env\.production/);
  assert.match(render(blocked(['secrets/prod.json'], '')!), /sensitive/);
  assert.match(render(blocked(['src/a.ts'], 'const apiKey = "abcdefghijklmnopqrstuvwxyz"')!), /secret/);
  assert.equal(blocked(['src/a.ts', 'src/environment.ts'], 'const token = getToken();'), undefined);
  assert.equal(addedLines('--- a/x\n+++ b/x\n@@\n-old token="aaaaaaaaaaaaaaaaaaaaaaaa"\n+new\n context'), '+new', 'a removed secret is not a new one');
});

test('the packages a fix touched come from its files; odd shapes are warnings, not failures', () => {
  const route = { packageGlobs: ['packages/*'], sharedPaths: ['packages/components', 'scripts'] };
  const one = touched(['packages/act/src/a.ts', 'packages/components/Button.tsx', 'scripts/build.js'], route);
  assert.deepEqual(one, { packages: ['packages/act'], shared: ['packages/components/Button.tsx', 'scripts/build.js'], other: [] });
  assert.deepEqual(warnings(one, route, 'packages/act'), []);
  assert.match(render(warnings(one, route, 'packages/pay')[0]), /in packages\/act, not in packages\/pay/);
  const two = touched(['packages/act/a.ts', 'packages/pay/b.ts', 'package.json', 'packages/README.md'], route);
  assert.deepEqual([two.packages, two.other], [['packages/act', 'packages/pay'], ['package.json', 'packages/README.md']]);
  assert.deepEqual(warnings(two, route).map(note => render(note).split(':')[0]), ['The fix touches 2 packages', 'Changed outside the packages and shared paths']);
  assert.match(render(warnings(touched(['scripts/x.js'], route), route)[0]), /no package was built/);
  assert.deepEqual(warnings(touched(['a.ts', 'b.ts'], { packageGlobs: [], sharedPaths: [] }), { packageGlobs: [] }), [], 'a repository that is one project has no such rules');
});

test('test commands run once per touched package with the build script it has', () => {
  assert.equal(chooseScript('{"scripts":{"build":"x","build:test":"y"}}', ['build:test', 'build-test', 'build']), 'build:test');
  assert.equal(chooseScript('{"scripts":{"dev":"x"}}', ['build']), undefined);
  assert.equal(chooseScript('not json', ['build']), undefined);
  const templates = ['pnpm install --frozen-lockfile', 'pnpm --dir {package} run {script}', 'pnpm --dir {package} lint'];
  const result = commands(templates, [{ path: 'packages/act', script: 'build:test' }, { path: "packages/it's", script: undefined }]);
  assert.deepEqual(result.run, ['pnpm install --frozen-lockfile', "pnpm --dir 'packages/act' run 'build:test'", "pnpm --dir 'packages/act' lint", "pnpm --dir 'packages/it'\\''s' lint"]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(commands(templates, []).run, ['pnpm install --frozen-lockfile']);
});
