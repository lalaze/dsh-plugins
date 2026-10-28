#!/usr/bin/env node
// Recovery for profiles that already fail to open (deepseek-ai/deepseek-harness#10598).
// Fully quit DSH Desktop first, then:
//   node reset-auth-cookies.mjs <path to Cookies file or Electron user-data dir> [--dry-run]
// Deletes only loopback `dsh-auth-*` rows; a backup `Cookies.bak-<time>` is written first.
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find(arg => !arg.startsWith('--'));
if (!target) {
  console.error('usage: node reset-auth-cookies.mjs <Cookies file | user-data dir> [--dry-run]');
  process.exit(2);
}

function resolveCookies(path) {
  if (existsSync(path) && statSync(path).isFile()) return path;
  for (const candidate of [join(path, 'Network', 'Cookies'), join(path, 'Cookies')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no Cookies database found at ${path}`);
}

const file = resolveCookies(target);
const where = "name LIKE 'dsh-auth-%' AND host_key IN ('127.0.0.1', 'localhost', '[::1]')";
const db = new DatabaseSync(file, { readOnly: dryRun });
try {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM cookies WHERE ${where}`).get();
  console.log(`${file}: ${count} dsh-auth cookie(s)`);
  if (dryRun || count === 0) process.exit(0);
  const backup = `${file}.bak-${Date.now()}`;
  copyFileSync(file, backup);
  db.exec('BEGIN IMMEDIATE');
  db.exec(`DELETE FROM cookies WHERE ${where}`);
  db.exec('COMMIT');
  console.log(`deleted ${count}; backup at ${backup}`);
} catch (error) {
  if (/locked|busy/i.test(String(error))) console.error('Cookies database is in use: fully quit DSH Desktop and retry.');
  throw error;
} finally {
  db.close();
}
