import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { machineIdOf, MachineBook, normalizeUrl } from '../src/machines.js';
import type { Hello } from '../src/model.js';

const hello = (id: string, name: string): Hello => ({ dshMachines: 1, id, name, os: 'macOS', version: '0.1.0' });
const refused = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });

test('addresses normalise to one origin', () => {
  assert.equal(normalizeUrl('100.1.1.1:7390'), 'http://100.1.1.1:7390');
  assert.equal(normalizeUrl(' http://100.1.1.1:7390/x '), 'http://100.1.1.1:7390');
  assert.equal(normalizeUrl('ftp://x'), undefined);
  assert.equal(machineIdOf('http://100.1.1.1:7390'), machineIdOf('http://100.1.1.1:7390'));
  assert.match(machineIdOf('http://100.1.1.1:7390'), /^m[0-9a-f]{10}$/);
});

test('the book lists what answered, keeps tailnet machines it knew as offline, and never lists itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-book-'));
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
    // The Air goes to sleep: the tailnet says offline, the book still knows it.
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
