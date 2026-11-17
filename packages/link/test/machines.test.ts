import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machineIdOf, MachineBook, normalizeUrl } from '../src/machines.js';
import type { Hello } from '../src/model.js';

const hello = (id: string, name: string): Hello => ({ dshLink: 1, id, name, os: 'macOS', version: '0.1.0' });
const refused = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

test('addresses normalise to one origin', () => {
  assert.equal(normalizeUrl('100.1.1.1:7390'), 'http://100.1.1.1:7390');
  assert.equal(normalizeUrl(' http://100.1.1.1:7390/x '), 'http://100.1.1.1:7390');
  assert.equal(normalizeUrl('ftp://x'), undefined);
  assert.equal(machineIdOf('http://100.1.1.1:7390'), machineIdOf('http://100.1.1.1:7390'));
  assert.match(machineIdOf('http://100.1.1.1:7390'), /^m[0-9a-f]{10}$/);
});

test('the book lists what answered, keeps tailnet machines it knew as offline, and never lists itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-book-'));
  try {
    const file = join(dir, 'machines.json');
    const book = new MachineBook(file, () => 'me');
    let changes = 0;
    book.onChange(() => changes++);
    const answers: Record<string, () => Hello> = {
      'http://100.0.0.1:7390': () => hello('air', 'lalazemacbook-air'),
      'http://100.0.0.2:7390': () => { throw refused(); },
      'http://100.0.0.3:7390': () => hello('me', 'myself'),
      'http://100.0.0.4:7390': () => { throw refused(); },
    };
    const probe = async (url: string) => answers[url]!();
    await book.refresh([
      { url: 'http://100.0.0.1:7390', source: 'tailnet', online: true },
      { url: 'http://100.0.0.2:7390', source: 'tailnet', online: true, name: 'pve01' },
      { url: 'http://100.0.0.3:7390', source: 'static', online: true },
      { url: 'http://100.0.0.4:7390', source: 'static', online: true },
    ], probe);
    assert.deepEqual(book.list().map(machine => [machine.name, machine.state, machine.reason]), [['100.0.0.4:7390', 'unreachable', 'no-listener'], ['lalazemacbook-air', 'online', undefined]]);
    assert.equal(changes, 1);
    // The same answers again change nothing.
    await book.refresh([{ url: 'http://100.0.0.1:7390', source: 'tailnet', online: true }, { url: 'http://100.0.0.4:7390', source: 'static', online: true }], probe);
    assert.equal(changes, 1);
    // Tailscale lost its coordination server on the Air and calls it offline, but it still answers: online.
    await book.refresh([{ url: 'http://100.0.0.1:7390', source: 'tailnet', online: false, lastSeen: 5 }], probe);
    assert.deepEqual(book.list().map(machine => [machine.name, machine.state]), [['lalazemacbook-air', 'online']]);
    // An offline machine nobody knew is not even asked.
    const asked: string[] = [];
    await book.refresh([{ url: 'http://100.0.0.9:7390', source: 'tailnet', online: false }], async url => { asked.push(url); return hello('x', 'x'); });
    assert.deepEqual(asked, []);
    // The Air goes to sleep: the tailnet says offline, it does not answer, the book still knows it.
    answers['http://100.0.0.1:7390'] = () => { throw refused(); };
    await book.refresh([{ url: 'http://100.0.0.1:7390', source: 'tailnet', online: false, lastSeen: 5 }], probe);
    const air = book.list()[0]!;
    assert.deepEqual([air.name, air.state], ['lalazemacbook-air', 'offline']);
    assert.ok(air.lastSeen! > 5);
    // A restart reads what it knew.
    const again = new MachineBook(file, () => 'me');
    again.load();
    await again.refresh([{ url: 'http://100.0.0.1:7390', source: 'tailnet', online: false }], probe);
    assert.equal(again.get(machineIdOf('http://100.0.0.1:7390'))?.name, 'lalazemacbook-air');
    assert.ok(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).includes('http://100.0.0.1:7390'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a tailnet machine whose plugin stopped answering for ten minutes is forgotten, and comes back when it answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-forget-'));
  try {
    const file = join(dir, 'machines.json');
    const url = 'http://100.0.0.5:7390', id = machineIdOf(url);
    const seen = (minutesAgo: number) => writeFileSync(file, JSON.stringify({ [url]: { name: 'docker', os: 'linux', lastSeen: Date.now() - minutesAgo * 60_000 } }));
    const candidate = { url, source: 'tailnet' as const, online: true };
    // DSH restarting there: nothing listens for a moment, the machine stays (unreachable).
    seen(1);
    let book = new MachineBook(file, () => 'me'); book.load();
    await book.refresh([candidate], async () => { throw refused(); });
    assert.deepEqual(book.list().map(machine => [machine.name, machine.state, machine.reason]), [['docker', 'unreachable', 'no-listener']]);
    // DSH removed there: after ten minutes of nothing answering it is gone, from the file too.
    seen(11);
    book = new MachineBook(file, () => 'me'); book.load();
    await book.refresh([candidate], async () => { throw Object.assign(new Error('not ours'), { code: 'not-plugin' }); });
    assert.deepEqual(book.list(), []);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
    // A machine that only does not answer in time stays, as does one Tailscale calls offline (asleep).
    seen(60);
    book = new MachineBook(file, () => 'me'); book.load();
    await book.refresh([candidate], async () => { throw Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }); });
    assert.equal(book.get(id)?.state, 'unreachable');
    await book.refresh([{ ...candidate, online: false }], async () => { throw refused(); });
    assert.equal(book.get(id)?.state, 'offline');
    // Installed again: it is found like any new machine.
    seen(11);
    book = new MachineBook(file, () => 'me'); book.load();
    await book.refresh([candidate], async () => { throw refused(); });
    assert.deepEqual(book.list(), []);
    await book.refresh([candidate], async () => hello('docker-id', 'docker'));
    assert.deepEqual(book.list().map(machine => [machine.name, machine.state]), [['docker', 'online']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
