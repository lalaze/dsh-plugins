import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
import { HolderOutput } from '../src/holder-output.js';

function harness() {
  const sent = new Map<string, Buffer[]>(), barriers: (() => void)[] = [];
  const output = new HolderOutput<string>((client, frame) => {
    const list = sent.get(client) ?? [];
    list.push(frame); sent.set(client, list);
  });
  const barrier = (ready: () => void) => { barriers.push(ready); };
  const text = (client: string) => (sent.get(client) ?? []).map(value => value.toString());
  return { output, sent, barriers, barrier, text };
}

test('live output is synchronous even when snapshot parsing is blocked', () => {
  const { output, barrier, barriers, text, sent } = harness();
  output.add('live');
  const first = Buffer.from('first'), second = Buffer.from('second');
  output.write(first);
  let connected = false;
  output.replay('joining', barrier, () => Buffer.from('snapshot:first'), () => { connected = true; });
  output.write(second);
  assert.deepEqual(text('live'), ['first', 'second'], 'no parser callback has run');
  assert.deepEqual(text('joining'), [], 'no raw output before the reset/snapshot');
  assert.equal(connected, false);
  barriers.shift()!();
  assert.deepEqual(text('joining'), ['snapshot:first', 'second']);
  assert.strictEqual(sent.get('joining')![1], second, 'held frames share the immutable buffer');
  assert.equal(connected, true);
  output.write(Buffer.from('third'));
  assert.deepEqual(text('joining'), ['snapshot:first', 'second', 'third']);
});

test('overlapping joins each receive their own snapshot boundary without duplicates', () => {
  const { output, barrier, barriers, text } = harness();
  output.add('live');
  output.write(Buffer.from('A'));
  output.replay('one', barrier, () => Buffer.from('snapshot:A'), () => {});
  output.write(Buffer.from('B'));
  output.replay('two', barrier, () => Buffer.from('snapshot:AB'), () => {});
  output.write(Buffer.from('C'));
  barriers.shift()!();
  output.write(Buffer.from('D'));
  barriers.shift()!();
  output.write(Buffer.from('E'));
  assert.deepEqual(text('live'), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(text('one'), ['snapshot:A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(text('two'), ['snapshot:AB', 'C', 'D', 'E']);
});

test('disconnect and replacement hello invalidate queued snapshot and resize work', () => {
  const { output, barrier, barriers, text } = harness();
  let snapshots = 0, connections = 0;
  const snapshot = () => { snapshots += 1; return Buffer.from('snapshot'); };
  const connected = () => { connections += 1; };
  output.replay('gone', barrier, snapshot, connected);
  output.write(Buffer.from('not retained after disconnect'));
  output.remove('gone');
  barriers.shift()!();
  assert.equal(snapshots, 0);
  assert.equal(connections, 0);
  assert.deepEqual(text('gone'), []);
  output.replay('retry', barrier, snapshot, connected);
  output.write(Buffer.from('covered by replacement snapshot'));
  output.replay('retry', barrier, snapshot, connected);
  output.write(Buffer.from('after replacement'));
  barriers.shift()!();
  assert.equal(snapshots, 0);
  barriers.shift()!();
  assert.equal(snapshots, 1);
  assert.equal(connections, 1);
  assert.deepEqual(text('retry'), ['snapshot', 'after replacement']);
  output.remove('retry');
  output.write(Buffer.from('no more'));
  assert.equal(text('retry').length, 2);
});

test('joining an already live client does not receive output ahead of its fresh snapshot', () => {
  const { output, barrier, barriers, text } = harness();
  output.add('one');
  output.write(Buffer.from('old'));
  output.replay('one', barrier, () => Buffer.from('reset:old'), () => {});
  output.write(Buffer.from('new'));
  assert.deepEqual(text('one'), ['old']);
  barriers.shift()!();
  assert.deepEqual(text('one'), ['old', 'reset:old', 'new']);
});

test('immediate barriers and fragmented ANSI/UTF-8 output retain exact bytes', () => {
  const { output, text, sent } = harness();
  output.replay('one', ready => ready(), () => Buffer.from('snapshot'), () => {});
  const bytes = Buffer.from('\x1b[32m中文🙂\x1b[0m\r\n');
  for (const byte of bytes) output.write(Buffer.from([byte]));
  assert.equal(text('one')[0], 'snapshot');
  assert.deepEqual(Buffer.concat(sent.get('one')!.slice(1)), bytes);
});

const screen = () => {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true });
  const serialize = new SerializeAddon(); terminal.loadAddon(serialize);
  return { terminal, serialize };
};
const parsed = (terminal: HeadlessTerminal) => new Promise<void>(resolve => terminal.write('', resolve));

test('real headless snapshot plus catch-up matches uninterrupted ANSI and Unicode output', async () => {
  const holder = screen(), live = screen(), joined = screen();
  try {
    const output = new HolderOutput<HeadlessTerminal>((client, frame) => client.write(frame));
    output.add(live.terminal);
    const write = (chunk: Buffer) => { output.write(chunk); holder.terminal.write(chunk); };
    write(Buffer.from('header 中文\r\n' + 'older line\r\n'.repeat(100)));
    let connected = false;
    output.replay(joined.terminal, ready => holder.terminal.write('', ready),
      () => Buffer.from(`\x1bc${holder.serialize.serialize({ scrollback: 2000 })}`), () => { connected = true; });
    // These bytes are received before the snapshot barrier runs but must be played AFTER the snapshot, exactly once.
    const later = Buffer.from('\x1b[31mnew 中文🙂\x1b[0m\r\nprogress 0%\r\x1b[2Kprogress 100%\r\n');
    for (const byte of later) write(Buffer.from([byte]));
    assert.equal(connected, false);
    await parsed(holder.terminal);
    assert.equal(connected, true);
    write(Buffer.from('after joining\r\n'));
    await Promise.all([holder, live, joined].map(value => parsed(value.terminal)));
    const expected = holder.serialize.serialize();
    assert.equal(live.serialize.serialize(), expected);
    assert.equal(joined.serialize.serialize(), expected);
  } finally { for (const value of [holder, live, joined]) value.terminal.dispose(); }
});
