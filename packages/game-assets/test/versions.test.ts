import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Asset } from '../src/domain.js';
import { groupVersions, versionOf } from '../src/versions.js';

test('folder names carry a version only when it is set apart from the name', () => {
  assert.deepEqual(versionOf('cozy-cast-v9'), { name: 'cozy-cast', version: '9', label: 'v9' });
  assert.deepEqual(versionOf('cozy-cast-v9-pilot'), { name: 'cozy-cast', version: '9', label: 'v9-pilot' });
  assert.deepEqual(versionOf('tiles_v2.1'), { name: 'tiles', version: '2.1', label: 'v2.1' });
  assert.deepEqual(versionOf('V3'), { name: '', version: '3', label: 'v3' });
  for (const name of ['nav2', 'dev-v8engine', 'eleven', 'cats', '2026-10-21']) assert.equal(versionOf(name), undefined, name);
});

const asset = (path: string, usage: Asset['usage'] = 'unused', size = 10): Asset => ({ path, usage, size, mtimeMs: 0, refCount: 0 });

test('sibling versions form a family, oldest first, with usage counted per version', () => {
  const assets = [asset('gen/cast-v10/a.png', 'used'), asset('gen/cast-v9/a.png'), asset('gen/cast-v9/sub/b.png', 'maybe'), asset('gen/cast-v9-pilot/a.png'),
    asset('gen/solo-v1/a.png'), asset('public/cast-v9/a.png', 'used'), asset('plain/a.png')];
  const families = groupVersions(assets);
  assert.deepEqual(families, [{ id: 'gen/cast', dir: 'gen', name: 'cast', versions: [
    { label: 'v9', path: 'gen/cast-v9', total: 2, used: 0, maybe: 1, bytes: 20 },
    { label: 'v9-pilot', path: 'gen/cast-v9-pilot', total: 1, used: 0, maybe: 0, bytes: 10 },
    { label: 'v10', path: 'gen/cast-v10', total: 1, used: 1, maybe: 0, bytes: 10 },
  ] }]);
  assert.deepEqual(assets.map(a => [a.family, a.version]), [['gen/cast', 'v10'], ['gen/cast', 'v9'], ['gen/cast', 'v9'], ['gen/cast', 'v9-pilot'],
    [undefined, undefined], [undefined, undefined], [undefined, undefined]]);
});
