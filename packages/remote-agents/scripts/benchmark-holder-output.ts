/**
 * Run: node --import tsx scripts/benchmark-holder-output.ts
 * Compares the old parse-before-forward order with HolderOutput's live fast path using real headless xterm parsing.
 * This is an in-process burst benchmark, NOT SSH round-trip time, browser paint time or a throughput claim.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { HolderOutput } from '../src/workspace/holder-output.js';
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

const line = Buffer.from('\x1b[2K\r\x1b[38;2;100;180;240m正在处理 remote terminal output 0123456789\x1b[0m\r\n');
const burst = (size: number) => Buffer.concat(Array.from({ length: Math.ceil(size / line.length) }, () => line)).subarray(0, size);
const cases = [
  { name: 'short-echo', data: Buffer.from('hello 中文\r\n') },
  { name: 'ansi-256KiB', data: burst(256 * 1024) },
  { name: 'ansi-1MiB', data: burst(1024 * 1024) },
];
async function run(data: Buffer, mode: 'parse-first' | 'live-first') {
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 2000, allowProposedApi: true });
  let bytes = 0, first = 0, last = 0;
  const start = performance.now();
  const send = (_client: string, chunk: Buffer) => {
    const now = performance.now() - start;
    if (!bytes) first = now;
    last = now; bytes += chunk.length;
  };
  const output = new HolderOutput(send); output.add('client');
  try {
    // At most 1 MiB: below the production parser's 2 MiB high-water mark. No artificial parser delay.
    for (let at = 0; at < data.length; at += 4096) {
      const chunk = data.subarray(at, at + 4096);
      if (mode === 'parse-first') terminal.write(chunk, () => send('client', chunk));
      else { output.write(chunk); terminal.write(chunk, () => {}); }
    }
    await new Promise<void>(resolve => terminal.write('', resolve));
    assert.equal(bytes, data.length);
    return { firstForwardMs: +first.toFixed(3), lastForwardMs: +last.toFixed(3), parseDoneMs: +(performance.now() - start).toFixed(3) };
  } finally { terminal.dispose(); }
}
// Warm both paths before measuring; alternate the order to avoid always giving one side the warmed parser.
await run(burst(256 * 1024), 'parse-first'); await run(burst(256 * 1024), 'live-first');
const results = [];
for (let round = 1; round <= 3; round += 1) {
  for (const sample of cases) {
    for (const mode of (round % 2 ? ['parse-first', 'live-first'] : ['live-first', 'parse-first']) as ('parse-first' | 'live-first')[]) {
      results.push({ round, scenario: sample.name, bytes: sample.data.length, mode, ...await run(sample.data, mode) });
    }
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, results }, null, 2));
