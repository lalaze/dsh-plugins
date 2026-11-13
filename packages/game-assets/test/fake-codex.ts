/** A stand-in for the Codex CLI, shared by the tests that make Codex draw. */
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for the Codex CLI: it records its arguments and prompt, and answers as `codex exec --json` does. Its mode
 * comes from FAKE_CODEX_MODE: `ok` saves the picture under CODEX_HOME/generated_images/<thread>/, `inline` puts it in
 * the event, `auth` fails as a revoked login does.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }) + '\\n');
  const out = event => process.stdout.write(JSON.stringify(event) + '\\n'), thread = 'thread-' + process.pid;
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  const mode = process.env.FAKE_CODEX_MODE || 'ok';
  if (mode === 'auth') {
    process.stderr.write('2026-11-13T09:59:16Z ERROR codex_login: Failed to refresh token\\n');
    out({ type: 'error', message: 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.' });
    out({ type: 'turn.failed', error: { message: 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.' } });
    process.exit(1);
  }
  const picture = Buffer.from(process.env.FAKE_CODEX_PNG, 'base64');
  if (mode === 'inline') out({ type: 'item.completed', item: { id: 'ig_1', type: 'image_generation', result: picture.toString('base64') } });
  else {
    const dir = path.join(process.env.CODEX_HOME, 'generated_images', thread);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'exec-1.png'), picture);
  }
  out({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'Here is the slime.' } });
  out({ type: 'turn.completed', usage: {} });
});
`;
/** A PNG header of 1024 × 1024 in 120 bytes: the picture the stand-in draws. */
export const CODEX_PICTURE = (() => {
  const data = Buffer.alloc(120, 7);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(1024, 16); data.writeUInt32BE(1024, 20);
  return data;
})();
export interface CodexCall { args: string[]; prompt: string; cwd: string }
/** Puts the stand-in at `<bin>/codex` and points this process's environment at it; `calls` reads what it was asked. */
export async function fakeCodex() {
  const bin = await mkdtemp(join(tmpdir(), 'dsh-fake-codex-bin-')), home = await mkdtemp(join(tmpdir(), 'dsh-fake-codex-home-')), log = join(home, 'calls.log');
  await writeFile(join(bin, 'codex'), FAKE_CODEX); await chmod(join(bin, 'codex'), 0o755);
  Object.assign(process.env, { CODEX_HOME: home, FAKE_CODEX_LOG: log, FAKE_CODEX_PNG: CODEX_PICTURE.toString('base64'), FAKE_CODEX_MODE: 'ok' });
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as CodexCall);
  return { bin, home, command: join(bin, 'codex'), dirs: [bin, home], calls };
}
