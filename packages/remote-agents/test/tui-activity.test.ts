import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactingOnScreen, dialogOnScreen, reportActivity, titleActivity, TuiActivityWatcher, type WatchedTerminal } from '../src/workspace/tui-activity.js';

/** A terminal whose title, status reports and screen a test sets by hand, as the CLI would over the wire. */
function fakeTerminal(name = 'Remote Claude') {
  const titles = new Set<(title: string) => void>(), reports = new Set<(data: string) => boolean>();
  const terminal: WatchedTerminal & { title(text: string): void; report(text: string): void; rows: string[]; disposed(): boolean } = {
    info: { state: 'running', shell: { name } },
    rows: [],
    screen: {
      get rows() { return terminal.rows.length; },
      buffer: { active: { viewportY: 0, getLine: y => ({ translateToString: () => terminal.rows[y] ?? '' }) } },
      onTitleChange(listener) { titles.add(listener); return { dispose: () => titles.delete(listener) }; },
      parser: { registerOscHandler(code, handler) { assert.equal(code, 7501); reports.add(handler); return { dispose: () => reports.delete(handler) }; } },
    },
    title(text) { for (const listener of titles) listener(text); },
    report(text) { for (const handler of reports) handler(text); },
    disposed: () => titles.size === 0 && reports.size === 0,
  };
  return terminal;
}

function rig(ids = ['a']) {
  const terminals = new Map<string, WatchedTerminal[]>(), emitted: [string, boolean][] = [];
  let now = 1000;
  /** Long past the seconds in which a CLI's start does not count, unless a test asks for those. */
  const settled = () => { now += 60_000; };
  const watcher = new TuiActivityWatcher({
    sessions: () => ids, terminals: id => terminals.get(id) ?? [], emit: (id, running) => emitted.push([id, running]), now: () => now,
  });
  /** What was reported, without the repeats of a run that lasts. */
  const changes = () => emitted.filter((entry, index) => index === 0 || entry[1] !== emitted[index - 1][1]);
  return { watcher, terminals, emitted, changes, advance(ms: number) { now += ms; watcher.check(); }, ids, settled };
}

test('a title reads as what the CLI is doing, for both CLIs as measured', () => {
  // Claude Code 2.1.318: ✳ at rest, a turning half circle at work.
  assert.equal(titleActivity('✳ Pong reply request'), 'idle');
  assert.equal(titleActivity('◐ Pong reply request'), 'running');
  assert.equal(titleActivity('◑ Claude Code'), 'running');
  // Codex 0.166: the folder at rest, a braille spinner at work, a blinking mark when blocked.
  assert.equal(titleActivity('dsh-plugins'), 'idle');
  assert.equal(titleActivity('⠙ dsh-plugins'), 'running');
  assert.equal(titleActivity('[ ! ] Action Required | Run shell command | dsh-plugins'), 'approval');
  assert.equal(titleActivity('[ . ] Action Required | Run shell command | dsh-plugins'), 'approval');
  // A shell, or a folder whose name has several words or starts with a digit.
  assert.equal(titleActivity(''), 'idle');
  assert.equal(titleActivity('my project'), 'idle');
  assert.equal(titleActivity('2 fast'), 'idle');
  assert.equal(titleActivity('项目 甲'), 'idle');
});

test('a status report reads as what Codex says it is doing', () => {
  assert.equal(reportActivity('state=working:app=codex'), 'running');
  assert.equal(reportActivity('state=idle:app=codex'), 'idle');
  assert.equal(reportActivity('state=done:app=codex'), 'idle');
  assert.equal(reportActivity('state=blocked:app=codex:kind=permission'), 'approval');
  assert.equal(reportActivity('state=blocked:app=codex:kind=input'), 'question');
  // A state it does not know ends a run rather than holding it forever.
  assert.equal(reportActivity('state=sleeping:app=codex'), 'idle');
  // Claude Code's capability query says nothing.
  assert.equal(reportActivity('?'), undefined);
  assert.equal(reportActivity('nonsense'), undefined);
});

test('Claude Code\'s dialogs show on its screen, as its title reads at rest', () => {
  const permission = ['❯ run the shell command: touch x', ' Bash command', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow', '   3. No', ' Esc to cancel · Tab to amend', ''];
  assert.equal(dialogOnScreen(permission), 'approval');
  const question = ['❯ pick one', ' ☐ Color', 'Which color do you want: red or blue?', '❯ 1. Red', '     Pick red', '  2. Blue', '  3. Type something.', '────', '  4. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
  assert.equal(dialogOnScreen(question), 'question');
  // A reply asking the same further up does not make a question a permission.
  assert.equal(dialogOnScreen(['⏺ Do you want the long version?', '', '', '', '', '', '', '❯ pick', 'Which one?', '❯ 1. Red', 'Esc to cancel']), 'question');
  // The first visit's folder trust numbers nothing.
  assert.equal(dialogOnScreen([' Quick safety check: Is this a project you created?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel']), 'question');
  // Moving down the list keeps it a dialog.
  assert.equal(dialogOnScreen(['Which color?', '  1. Red', '❯ 2. Blue', 'Esc to cancel']), 'question');
  // The prompt at rest, empty, with a draft, and with an old numbered prompt above it.
  assert.equal(dialogOnScreen(['❯ hello', '⏺ hi', '────', '❯ ', '────', '  ⏵⏵ auto mode on']), undefined);
  assert.equal(dialogOnScreen(['⏺ hi', '────', '❯ fix the 1. item', '────']), undefined);
  assert.equal(dialogOnScreen(['❯ 1. first do this', '⏺ done', '────', '❯ ', '────']), undefined);
  assert.equal(dialogOnScreen([]), undefined);
});

test('running reports once its screen had a moment to arrive, and a rest only once it has lasted', () => {
  const { watcher, terminals, changes, advance, settled } = rig();
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check();
  settled();
  assert.deepEqual(changes(), [], 'a CLI at rest says nothing new');
  terminal.title('◐ Fix the bug');
  watcher.check();
  assert.deepEqual(changes(), [], 'what goes with the title reaches DSH after it');
  advance(1000);
  assert.deepEqual(changes(), [['a', true]]);
  assert.equal(watcher.isBusy('a'), true);
  // A blink between two tools does not count as finishing.
  terminal.title('✳ Fix the bug');
  advance(500);
  terminal.title('◑ Fix the bug');
  advance(5000);
  assert.deepEqual(changes(), [['a', true]]);
  terminal.title('✳ Fix the bug');
  advance(1000);
  assert.deepEqual(changes(), [['a', true]]);
  advance(2000);
  assert.deepEqual(changes(), [['a', true], ['a', false]]);
  assert.equal(watcher.isBusy('a'), false);
});

/** Claude Code 2.1.319's screen during a compaction it started by itself, as measured. */
const COMPACTING = [
  '✻ Worked for 2m 27s · done 3:03 AM', '', '✻ Compacting conversation… (23s · ↓ 1 tokens)',
  '  ⎿  Tip: Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.',
  '───────────', '❯ ', '───────────', '  ⏸ manual mode on · esc to interrupt',
];
const TURN = ['❯ 修复登录', '', '✽ Manifesting… (59s)', '', '───────────', '❯ ', '───────────', '  ⏸ manual mode on · esc to interrupt'];

test('a compaction shows on Claude Code\'s screen, and only in its spinner', () => {
  assert.equal(compactingOnScreen(COMPACTING), true);
  assert.equal(compactingOnScreen(TURN), false);
  assert.equal(compactingOnScreen(['⏺ Compacted while idle, before the prompt cache expired', '───', '❯ ', '───', '  ⏸ manual mode on · ? for shortcuts']), false, 'once it ended');
  assert.equal(compactingOnScreen(['  ✻ Compacting conversation… is what it printed', ...TURN]), false, 'a reply quoting it');
  assert.equal(compactingOnScreen(['✻ Compacting conversation… (23s)', 'a', 'b', 'c', 'd', 'e', 'f', 'g', '❯ ']), false, 'far above the prompt, so an old line');
  assert.equal(compactingOnScreen(['✻ Compacting conversation… (23s)']), false, 'no prompt, so not its screen');
  // The tip wraps on a narrow terminal.
  assert.equal(compactingOnScreen(['✻ Compacting conversation… (1s)', '  ⎿  Tip: Running', '  multiple Claude', '  sessions? Use', '────', '❯ ', '────']), true);
});

test('a compaction Claude Code starts by itself is no run, so nothing reads as finished', () => {
  const { watcher, terminals, emitted, advance, settled } = rig();
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check(); settled();
  // The title comes first, and the screen only after it, as they reach DSH.
  terminal.title('◐ Fix the bug');
  advance(100);
  terminal.rows = COMPACTING;
  for (let second = 0; second < 60; second++) advance(1000);
  assert.equal(watcher.isBusy('a'), false);
  terminal.title('✳ Fix the bug');
  terminal.rows = ['⏺ Compacted while idle, before the prompt cache expired', '───', '❯ ', '───'];
  for (let second = 0; second < 5; second++) advance(1000);
  assert.deepEqual(emitted, []);
});

test('a turn that follows a compaction counts from when the compaction gives way to it', () => {
  const { watcher, terminals, changes, advance, settled } = rig();
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check(); settled();
  terminal.title('◐ Fix the bug'); terminal.rows = COMPACTING;
  advance(1000); advance(1000);
  assert.deepEqual(changes(), []);
  terminal.rows = TURN;
  advance(1000);
  assert.deepEqual(changes(), [['a', true]]);
  terminal.title('✳ Fix the bug');
  advance(1000); advance(2000);
  assert.deepEqual(changes(), [['a', true], ['a', false]]);
});

test('a turn goes on running through a compaction in the middle of it', () => {
  const { watcher, terminals, changes, advance, settled } = rig();
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check(); settled();
  terminal.title('◐ Fix the bug'); terminal.rows = TURN;
  advance(1000); advance(1000);
  assert.deepEqual(changes(), [['a', true]]);
  terminal.rows = COMPACTING;
  for (let second = 0; second < 30; second++) advance(1000);
  assert.equal(watcher.isBusy('a'), true);
  assert.deepEqual(changes(), [['a', true]]);
});

test('a busy conversation says so again, as a DSH turn of its own can report it stopped', () => {
  const { watcher, terminals, emitted, advance, settled } = rig();
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check();
  settled();
  terminal.title('◐ Lead the team');
  watcher.check(); advance(1000);
  assert.deepEqual(emitted, [['a', true]]);
  advance(1000); advance(1000); advance(1000); advance(1000);
  assert.deepEqual(emitted, [['a', true]]);
  advance(1000);
  assert.deepEqual(emitted, [['a', true], ['a', true]]);
  // At rest it says nothing more.
  terminal.title('✳ Lead the team');
  advance(1000); advance(2000);
  assert.deepEqual(emitted, [['a', true], ['a', true], ['a', false]]);
  advance(10000);
  assert.deepEqual(emitted, [['a', true], ['a', true], ['a', false]]);
});

test('working in the first seconds of a CLI does not count, unless it lasts', () => {
  const { watcher, terminals, emitted, advance } = rig();
  const terminal = fakeTerminal('Remote Codex');
  terminals.set('a', [terminal]);
  watcher.check();
  // Codex 0.166 reports working as it starts and rests about two seconds later.
  terminal.report('state=working:app=codex');
  advance(1000);
  assert.equal(watcher.isBusy('a'), false);
  terminal.report('state=idle:app=codex');
  advance(1000); advance(3000);
  assert.deepEqual(emitted, []);
  // A real turn started right after that shows as soon as those seconds are over.
  terminal.report('state=working:app=codex');
  advance(1000);
  assert.deepEqual(emitted, []);
  advance(4000);
  assert.deepEqual(emitted, [['a', true]]);
  // A dialog does not wait for them.
  const other = fakeTerminal();
  terminals.set('a', [other]);
  advance(1000);
  other.rows = [' Do you want to proceed?', ' ❯ 1. Yes'];
  advance(1000);
  assert.deepEqual(watcher.waiting(), { a: 'approval' });
});

test('a dialog counts as waiting and keeps the conversation running, as a DSH approval does', () => {
  const { watcher, terminals, changes, advance, settled } = rig();
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check();
  settled();
  terminal.title('◐ Touch a file');
  watcher.check();
  terminal.title('✳ Touch a file');
  terminal.rows = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'];
  watcher.check();
  assert.deepEqual(watcher.waiting(), { a: 'approval' });
  advance(5000);
  assert.deepEqual(changes(), [['a', true]], 'no finish while it waits');
  // Answered, it works on.
  terminal.rows = ['⏺ Touching', '────', '❯ ', '────'];
  terminal.title('◑ Touch a file');
  advance(1000);
  assert.deepEqual(watcher.waiting(), {});
  terminal.title('✳ Touch a file');
  advance(1000); advance(2000);
  assert.deepEqual(changes(), [['a', true], ['a', false]]);
});

test('Codex\'s own report decides over its title and the screen', () => {
  const { watcher, terminals, emitted, advance, settled } = rig();
  const terminal = fakeTerminal('Remote Codex');
  terminals.set('a', [terminal]);
  watcher.check();
  settled();
  terminal.report('state=working:app=codex');
  terminal.title('dsh-plugins');
  watcher.check();
  assert.deepEqual(emitted, [['a', true]]);
  terminal.report('state=blocked:app=codex:kind=permission');
  terminal.title('[ ! ] Action Required | Run shell command | dsh-plugins');
  advance(1000);
  assert.deepEqual(watcher.waiting(), { a: 'approval' });
  // A numbered list in its reply is not a dialog.
  terminal.report('state=done:app=codex');
  terminal.title('dsh-plugins');
  terminal.rows = ['› 1. a thing', '  2. another'];
  advance(1000); advance(2000);
  assert.deepEqual(watcher.waiting(), {});
  assert.deepEqual(emitted, [['a', true], ['a', false]]);
  // Leaving Codex takes the report back, so a working report cannot outlive it.
  terminal.report('state=working:app=codex');
  advance(1000);
  assert.deepEqual(emitted, [['a', true], ['a', false], ['a', true]]);
  terminal.report('state=clear');
  terminal.title('');
  advance(1000); advance(2000);
  assert.deepEqual(emitted, [['a', true], ['a', false], ['a', true], ['a', false]]);
});

test('a terminal going away ends the run, and only the CLI\'s own terminal is watched', () => {
  const { watcher, terminals, emitted, advance, settled } = rig();
  const shell = fakeTerminal('zsh'), cli = fakeTerminal();
  terminals.set('a', [shell, cli]);
  watcher.check();
  settled();
  shell.title('◐ a program of its own');
  watcher.check();
  assert.deepEqual(emitted, [], 'another terminal of the conversation says nothing about its CLI');
  cli.title('◐ Fix the bug');
  watcher.check(); advance(1000);
  assert.deepEqual(emitted, [['a', true]]);
  cli.info.state = 'exited';
  advance(1000);
  assert.deepEqual(emitted, [['a', true], ['a', false]], 'no reason to wait: nothing can resume it');
  assert.equal(cli.disposed(), true);
  // The same conversation's next terminal starts fresh.
  const next = fakeTerminal();
  terminals.set('a', [next]);
  advance(1000);
  settled();
  next.title('◐ Again');
  advance(1000); advance(1000);
  assert.deepEqual(emitted, [['a', true], ['a', false], ['a', true]]);
  watcher.close();
  assert.equal(next.disposed(), true);
});

test('a conversation that is no longer a TUI one lets go of its terminal', () => {
  const ids = ['a'];
  const { watcher, terminals, emitted, advance, settled } = rig(ids);
  const terminal = fakeTerminal();
  terminals.set('a', [terminal]);
  watcher.check();
  settled();
  terminal.title('◐ Work');
  watcher.check(); advance(1000);
  ids.length = 0;
  watcher.check();
  assert.deepEqual(emitted, [['a', true], ['a', false]]);
  assert.equal(terminal.disposed(), true);
  assert.equal(watcher.isBusy('a'), false);
});
