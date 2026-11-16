import assert from 'node:assert/strict';
import { test } from 'node:test';
import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { alignScreen, reflowText } from '../src/holder-reflow.js';

const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');
const { SerializeAddon } = serializeAddon as unknown as typeof import('@xterm/addon-serialize');
type Term = InstanceType<typeof Terminal>;

const terminal = (cols: number, rows: number) => new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
const write = (term: Term, data: string) => new Promise<void>(resolve => term.write(data, resolve));
const allRows = (term: Term) => { const b = term.buffer.active, out: string[] = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y)!.translateToString(true)); return out; };
const screenRows = (term: Term) => allRows(term).slice(term.buffer.active.baseY);
/** Messages broken at `width` by the program, as Claude Code's classic renderer does. */
const transcript = (width: number, count = 30) => Array.from({ length: count }, (_, at) => `⏺ message ${at + 1}: ${'lorem ipsum dolor sit amet '.repeat(2 + at % 3).trim()}`).flatMap(text => {
  const lines: string[] = []; let line = '';
  for (const word of text.split(' ')) { if (line && line.length + 1 + word.length > width) { lines.push(line); line = `  ${word}`; } else line += line ? ` ${word}` : word; }
  return [...lines, line, ''];
});

test('the screen is found in what the copy printed by its top rows, at the last place they match', () => {
  const printed = ['banner', '', 'one two three', 'four five six', 'seven eight', '', 'one two three', 'four five six', 'seven eight', 'nine ten', '❯', '────'];
  const screen = ['one two three', 'four five six', 'seven eight', 'nine ten', '❯'];
  assert.equal(alignScreen(printed, screen), 6);
  // A first row the CLI kept from before the change of width: the next rows decide.
  assert.equal(alignScreen(printed, ['an old narrow row', 'one two three', 'four five six', 'seven eight', 'nine ten']), 5);
  // Blank rows and rules on top are carried along.
  assert.equal(alignScreen(printed, ['', 'one two three', 'four five six', 'seven eight', 'nine ten']), 5);
});

test('a screen that is not in what the copy printed is not placed anywhere', () => {
  const printed = ['alpha beta', 'gamma delta', 'epsilon zeta', 'eta theta'];
  assert.equal(alignScreen(printed, ['new output one', 'new output two', 'new output three', 'new output four']), undefined);
  // Too few rows to tell, such as a nearly empty screen after /clear.
  assert.equal(alignScreen(printed, ['alpha beta', '', '❯', '────']), undefined);
  assert.equal(alignScreen([], ['alpha beta', 'gamma delta', 'epsilon zeta']), undefined);
});

test('the rebuilt terminal has the copy\'s rows above the screen, and the screen, cursor and modes as they were', async () => {
  const cols = 40, rows = 8;
  // What the CLI printed at 70 columns, then its repaint of the screen at 40, as clients have it.
  const live = terminal(cols, rows), client = terminal(cols, rows);
  const before = `\x1b[?2004h${transcript(70).join('\r\n')}\r\n`;
  const narrow = transcript(cols), tail = narrow.slice(-(rows - 1));
  const repaint = `\x1b[H${'\x1b[2K\x1b[1B'.repeat(rows)}\x1b[H\x1b[1m${tail.join('\r\n')}\x1b[0m\r\n❯ draft`;
  for (const term of [live, client]) { await write(term, before); await write(term, repaint); }
  const screen = new SerializeAddon(); live.loadAddon(screen);
  // The copy at 40 columns: the whole conversation, then its own prompt.
  const copy = terminal(cols, rows), printed = new SerializeAddon(); copy.loadAddon(printed);
  await write(copy, `${narrow.join('\r\n')}\r\n❯ `);
  const start = alignScreen(allRows(copy), screenRows(live));
  assert.equal(start, narrow.length - (rows - 1));
  const text = reflowText(printed.serialize({ range: { start: 0, end: start! - 1 }, excludeModes: true }), start!, rows, screen.serialize({ scrollback: 0, excludeModes: true }));
  assert.ok(!text.includes('\x1bc') && !text.includes('?2004'), 'no reset and no mode switch: a terminal would answer one with its focus');
  await write(client, text);
  assert.deepEqual(allRows(client), [...narrow, '❯ draft'], 'one copy of everything, all at the new width');
  assert.deepEqual(screenRows(client), screenRows(live));
  assert.deepEqual([client.buffer.active.cursorX, client.buffer.active.cursorY], [live.buffer.active.cursorX, live.buffer.active.cursorY]);
  assert.equal(client.modes.bracketedPasteMode, true);
  assert.ok(client.buffer.active.getLine(client.buffer.active.baseY)!.getCell(0)!.isBold(), 'the screen keeps its styles');
  // What the CLI writes next lands where it would have.
  await write(live, ' more'); await write(client, ' more');
  assert.deepEqual(screenRows(client), screenRows(live));
});

test('a conversation shorter than the screen leaves nothing above it', async () => {
  const cols = 40, rows = 10, live = terminal(cols, rows), client = terminal(cols, rows);
  for (const term of [live, client]) await write(term, 'old wide line that goes on\r\n⏺ hello there friend\r\n⏺ second message here\r\n⏺ third message here\r\n❯ ');
  const screen = new SerializeAddon(); live.loadAddon(screen);
  const copy = terminal(cols, rows);
  await write(copy, 'old wide line that goes on\r\n⏺ hello there friend\r\n⏺ second message here\r\n⏺ third message here\r\n❯ ');
  const start = alignScreen(allRows(copy), screenRows(live));
  assert.equal(start, 0);
  await write(client, reflowText('', 0, rows, screen.serialize({ scrollback: 0, excludeModes: true })));
  assert.equal(client.buffer.active.baseY, 0);
  assert.deepEqual(screenRows(client), screenRows(live));
  assert.deepEqual([client.buffer.active.cursorX, client.buffer.active.cursorY], [live.buffer.active.cursorX, live.buffer.active.cursorY]);
});
