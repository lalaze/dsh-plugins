import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeptTerminals } from '../src/client/tui-kept.js';

interface FakeHost { id: number; place?: string; remove(): void }
function rig(limit = 3) {
  const saved = new Map<string, number>([['loaded', 4]]);
  let hosts = 0, changes = 0;
  const place = (name: string) => ({ append(host: FakeHost) { host.place = name; } });
  const kept = new KeptTerminals<FakeHost>(limit, place('hidden'), () => ({ id: ++hosts, remove() { this.place = undefined; } }), {
    load: id => saved.get(id) ?? 0,
    save: (id, generation) => { saved.set(id, generation); },
  });
  kept.subscribe(() => { changes += 1; });
  const area = place('area');
  const item = (id: string) => kept.snapshot().find(terminal => terminal.sessionId === id);
  return { kept, area, item, saved, changes: () => changes, ids: () => kept.snapshot().map(terminal => terminal.sessionId) };
}

test('a terminal goes to the area when shown and to the hidden place when left, in the same element', () => {
  const { kept, area, item } = rig();
  const hide = kept.show('a', '/shell', area);
  const host = item('a')!.host;
  assert.equal(host.place, 'area');
  assert.equal(item('a')!.visible, true);
  hide();
  assert.equal(item('a')!.host, host);
  assert.equal(host.place, 'hidden');
  assert.equal(item('a')!.visible, false);
  kept.show('a', '/other', area);
  assert.equal(item('a')!.host, host, 'coming back reuses the element');
  assert.equal(item('a')!.shell, '/shell', 'and the terminal it holds');
  assert.equal(host.place, 'area');
});

test('only the most recently used stay open, and using one again keeps it', () => {
  const { kept, area, item, ids } = rig(3);
  for (const id of ['a', 'b', 'c']) kept.show(id, '/shell', area)();
  const oldest = item('a')!.host;
  kept.show('a', '/shell', area)();
  kept.show('d', '/shell', area)();
  assert.deepEqual(ids(), ['c', 'a', 'd'], 'b was used longest ago, as a was used again');
  assert.equal(oldest.place, 'hidden');
  kept.show('e', '/shell', area);
  assert.deepEqual(ids(), ['a', 'd', 'e']);
  assert.equal(item('e')!.visible, true);
  assert.equal(oldest.place, 'hidden');
  kept.show('f', '/shell', area);
  assert.equal(oldest.place, undefined, 'one pushed out leaves the document');
});

test('a terminal starts from its saved generation, and replacing it saves the next', () => {
  const { kept, area, item, saved } = rig();
  kept.show('loaded', '/shell', area);
  assert.equal(kept.generation('loaded'), 4);
  const host = item('loaded')!.host;
  kept.restart('loaded');
  assert.equal(kept.generation('loaded'), 5);
  assert.equal(saved.get('loaded'), 5);
  assert.equal(item('loaded')!.host, host, 'the new one goes in the same place on screen');
  assert.equal(kept.generation('unknown'), undefined);
  kept.restart('unknown');
  assert.equal(saved.has('unknown'), false);
});

test('a dropped terminal is gone, and leaving its conversation afterwards does nothing', () => {
  const { kept, area, item, ids, changes } = rig();
  const hide = kept.show('a', '/shell', area);
  const host = item('a')!.host;
  kept.drop('a');
  assert.deepEqual(ids(), []);
  assert.equal(host.place, undefined);
  const seen = changes();
  hide();
  assert.equal(host.place, undefined, 'it does not reappear in the hidden place');
  assert.equal(changes(), seen);
  kept.show('a', '/shell', area);
  assert.notEqual(item('a')!.host, host, 'showing it again opens a new one');
});

test('leaving an old copy of a conversation does not hide its newer terminal', () => {
  const { kept, area, item } = rig();
  const hide = kept.show('a', '/shell', area);
  kept.drop('a');
  kept.show('a', '/shell', area);
  hide();
  assert.equal(item('a')!.visible, true);
  assert.equal(item('a')!.host.place, 'area');
});
