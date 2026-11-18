/**
 * Stand-in for the `h3` CLI used by tests so no real Colab VM is ever booted.
 *
 * Modes (`FAKE_H3_MODE`, default `ok`):
 * - `ok`: `status` exits 1 (no active VM), `up` exits 0, each `edit` writes a 2048×2048 PNG and JSONL events, `down` exits 0.
 * - `already-up`: `status` exits 0 as when another agent already has the `h3` Colab session running.
 * - `boot-fail`: `up` exits 1 with an error on stderr.
 * - `slow-boot`: `up` stays alive until killed by SIGTERM.
 * - `gpu-wait`: `up` reports A100 busy and G4 not allowed, then 0.4 s later gets an A100 and finishes 0.4 s after that.
 * - `no-gpu`: `up` reports A100 busy, then gives up as h3 does when `--wait` runs out.
 * - `draw-fail-2`: the 2nd `edit` call since the latest `up` fails with `ok: false` and exit 1; the others succeed.
 * - `vm-died-2`: the 2nd `edit` call fails with `没有名为 'h3' 的 Colab 会话`, indicating a dead VM.
 * - `slow`: the 1st `edit` since `up` succeeds at once; the 2nd `edit` stays alive until killed by SIGTERM.
 * - `down-fail`: `down` exits 1.
 */
import { chmod, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE_H3 = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const sub = args[0] || '';
const mode = process.env.FAKE_H3_MODE || 'ok';
const logFile = process.env.FAKE_H3_LOG;

function readCalls() {
  if (!logFile || !fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line));
}

function editsSinceUp(previous) {
  let count = 0;
  for (let i = previous.length - 1; i >= 0; i--) {
    if (previous[i].sub === 'up') break;
    if (previous[i].sub === 'edit') count++;
  }
  return count;
}

const previous = readCalls();
const entry = { sub, args, pid: process.pid };
let slowChild = null;

if (sub === 'edit') {
  const outIdx = args.indexOf('-o');
  const sepIdx = args.indexOf('--');
  entry.outDir = outIdx >= 0 ? args[outIdx + 1] : '';
  entry.prompt = sepIdx >= 0 ? args[sepIdx + 1] : '';
  entry.reference = sepIdx >= 0 ? args[sepIdx + 2] : '';
  if (entry.reference && fs.existsSync(entry.reference)) {
    entry.refHex = fs.readFileSync(entry.reference).toString('hex');
  }
  const indexInBatch = editsSinceUp(previous) + 1;
  if (mode === 'slow' && indexInBatch >= 2) {
    const { spawn } = require('child_process');
    slowChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
    entry.subPid = slowChild.pid;
  }
}

if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\\n');
}

if (sub === 'status') {
  if (mode === 'already-up') {
    process.stdout.write("Session 'h3': running on NVIDIA A100-SXM4-80GB\\n");
    process.exit(0);
  }
  process.stderr.write("h3: 没有名为 'h3' 的 Colab 会话\\n");
  process.exit(1);
}

if (sub === 'up') {
  if (mode === 'boot-fail') {
    process.stderr.write('h3: Colab could not allocate an A100 runtime\\n');
    process.exit(1);
  }
  if (mode === 'slow-boot') {
    setTimeout(() => {}, 60000);
    return;
  }
  if (mode === 'gpu-wait' || mode === 'no-gpu') {
    const say = text => process.stdout.write(text + '\\n');
    say('申请 GPU：A100 → G4（都没空就每 30 秒再试一轮，最多等 10 分钟；分配到 VM 之前不扣 CU）');
    say('  A100：暂时没有空闲（Service Unavailable）');
    say('  G4：账号没有这种 GPU 的权限或配额，之后不再试');
    setTimeout(() => {
      say('  第 2 轮（已等 0.5 分钟）');
      if (mode === 'no-gpu') {
        process.stderr.write('h3: 试了 2 轮（0.5 分钟），A100 都没有空闲。没有开机，没有扣 CU。\\n');
        process.exit(1);
      }
      say('✓ 拿到 A100（第 2 轮，等了 0.5 分钟）');
      setTimeout(() => { process.stderr.write('ComfyUI ready\\n'); process.exit(0); }, 400);
    }, 400);
    return;
  }
  process.stderr.write('ComfyUI ready\\n');
  process.exit(0);
}

if (sub === 'edit') {
  const indexInBatch = editsSinceUp(previous) + 1;
  if (mode === 'slow' && indexInBatch >= 2) {
    setTimeout(() => {}, 60000);
    return;
  }
  if (mode === 'draw-fail-2' && indexInBatch === 2) {
    process.stdout.write(JSON.stringify({ event: 'image', ok: false, index: 1, error: 'ComfyUI workflow failed on image 2' }) + '\\n');
    process.stdout.write(JSON.stringify({ event: 'done', total: 1, ok: 0, failed: 1, out_dir: entry.outDir, minutes: 0.01, vm_running: true }) + '\\n');
    process.exit(1);
  }
  if (mode === 'vm-died-2' && indexInBatch === 2) {
    process.stdout.write(JSON.stringify({ event: 'error', error: "没有名为 'h3' 的 Colab 会话" }) + '\\n');
    process.exit(1);
  }
  fs.mkdirSync(entry.outDir, { recursive: true });
  const file = path.join(entry.outDir, 'h3-' + indexInBatch + '.png');
  const png = Buffer.from(process.env.FAKE_H3_PNG, 'base64');
  fs.writeFileSync(file, png);
  process.stdout.write(JSON.stringify({ event: 'image', ok: true, index: 1, path: file, meta: file.replace(/\\.png$/, '.json'), seed: indexInBatch, width: 2048, height: 2048, seconds: 1.5, prompt: entry.prompt }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'done', total: 1, ok: 1, failed: 0, out_dir: entry.outDir, minutes: 0.03, vm_running: true }) + '\\n');
  process.exit(0);
}

if (sub === 'down') {
  if (mode === 'down-fail') {
    process.stderr.write('h3: colab disconnect timed out\\n');
    process.exit(1);
  }
  process.exit(0);
}

process.stderr.write('h3: unknown subcommand ' + sub + '\\n');
process.exit(2);
`;

/** A 2048 × 2048 PNG header in 120 bytes: the picture the stand-in writes. */
export const H3_PICTURE = (() => {
  const data = Buffer.alloc(120, 9);
  data.writeUInt32BE(0x89504e47, 0);
  data.writeUInt32BE(0x0d0a1a0a, 4);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(2048, 16);
  data.writeUInt32BE(2048, 20);
  return data;
})();

export interface H3Call {
  sub: string;
  args: string[];
  pid: number;
  subPid?: number;
  outDir?: string;
  prompt?: string;
  reference?: string;
  refHex?: string;
}

export async function fakeH3() {
  const bin = await mkdtemp(join(tmpdir(), 'dsh-fake-h3-bin-'));
  const state = await mkdtemp(join(tmpdir(), 'dsh-fake-h3-state-'));
  const log = join(state, 'calls.log');
  const command = join(bin, 'h3');
  await writeFile(command, FAKE_H3);
  await chmod(command, 0o755);
  await writeFile(log, '');
  Object.assign(process.env, {
    FAKE_H3_LOG: log,
    FAKE_H3_PNG: H3_PICTURE.toString('base64'),
    FAKE_H3_MODE: 'ok',
  });
  const calls = async (): Promise<H3Call[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as H3Call);
  const clearCalls = async () => {
    await truncate(log, 0).catch(() => writeFile(log, ''));
  };
  return { bin, command, dirs: [bin, state], calls, clearCalls };
}
