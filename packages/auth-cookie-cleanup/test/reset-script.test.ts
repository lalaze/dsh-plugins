import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const script = join(import.meta.dirname, '..', 'bin', 'reset-auth-cookies.mjs');

test('reset script deletes only loopback dsh-auth rows and keeps a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cookies-'));
  try {
    mkdirSync(join(dir, 'Network'));
    const file = join(dir, 'Network', 'Cookies');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT)');
    const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?)');
    for (let i = 0; i < 71; i++) insert.run('127.0.0.1', `dsh-auth-${i}`, 'x');
    insert.run('127.0.0.1', 'other', 'x');
    insert.run('example.com', 'dsh-auth-remote', 'x');
    db.close();

    const dry = execFileSync(process.execPath, [script, dir, '--dry-run'], { encoding: 'utf8' });
    assert.match(dry, /71 dsh-auth cookie/);
    execFileSync(process.execPath, [script, dir], { encoding: 'utf8', stdio: 'pipe' });

    const after = new DatabaseSync(file, { readOnly: true });
    const rows = after.prepare('SELECT host_key, name FROM cookies ORDER BY name').all();
    after.close();
    assert.deepEqual(rows.map(row => `${row.host_key}/${row.name}`), ['example.com/dsh-auth-remote', '127.0.0.1/other']);
    assert.equal(readdirSync(join(dir, 'Network')).filter(name => name.startsWith('Cookies.bak-')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
