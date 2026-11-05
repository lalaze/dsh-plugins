import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { promptText, teamLine } from '../src/client/workspace/tui-team.js';
import { RemoteCliAdapter } from '../src/chat/native-chat.js';
import type { ChatProjects } from '../src/chat/projects.js';
import { CAPTAIN_GUIDE, promptIsEmpty, TuiCaptain, type CaptainTerminal, type ScreenLine, type TeamResult } from '../src/workspace/tui-captain.js';
import { fixture } from './fakes.js';

/** A screen line. `dim` from which column its text is dim, `inverse` the column the CLI draws its cursor on. */
const line = (text: string, style: { dim?: number; inverse?: number } = {}): ScreenLine => ({
  length: 60, translateToString: () => text.trimEnd(),
  getCell: x => ({ getChars: () => text[x] ?? '', isDim: () => (style.dim !== undefined && x >= style.dim ? 1 : 0), isInverse: () => (style.inverse === x ? 1 : 0) }),
});
const RULE = line('─'.repeat(40));

test('only an empty prompt counts as empty, so a draft or a dialog is never typed into', () => {
  const empty = (...lines: ScreenLine[]) => promptIsEmpty(lines);
  assert.equal(empty(line('❯ Earlier message'), line('• reply'), RULE, line('❯'), RULE, line('  ⏵⏵ auto mode on')), true, 'Claude Code, with its history above');
  assert.equal(empty(line('› Ask Codex to do anything', { dim: 2 }), line('  GPT-6 · ~/app')), true, 'Codex, whose placeholder is dim');
  assert.equal(empty(line('❯ check the file contents', { inverse: 2 })), true, 'a suggestion in plain colors, with the cursor on its first letter');
  assert.equal(empty(line('❯ half a thought', { inverse: 16 })), false, 'a draft, with the cursor after it');
  assert.equal(empty(line('› half a thought')), false);
  assert.equal(empty(line('   ❯ 5. Haiku 5.5 ✔   Fastest'), line('     6. Haiku 4.5'), line('   Enter to set as default')), false, 'a dialog\'s highlighted choice');
  assert.equal(empty(line('› 1. Yes, proceed'), line('  2. No')), false, 'an approval');
  assert.equal(empty(line('Resuming session…')), false, 'nothing is waiting for input yet');
  assert.equal(empty(), false);
});

/** A terminal whose prompt holds what is pasted until Enter, unless `loses` throws the paste away. */
function fakeTerminal(initial: ScreenLine[] = [line('❯')]) {
  const state = { lines: initial, writes: [] as string[], loses: 0 };
  const terminal: CaptainTerminal = { lines: () => state.lines, write: async data => {
    state.writes.push(data);
    if (data === '\r') state.lines = [line('❯')];
    else if (state.loses > 0) state.loses -= 1;
    else state.lines = [line('❯ [Pasted text #1]')];
  } };
  return { state, terminal };
}
async function setup(t: TestContext, sessionId = 'tui') {
  const f = await fixture(t);
  await f.store.update(s => { s.tuiSessions = [sessionId]; s.tuiDetails = { [sessionId]: { title: 'Claude Code' } }; });
  const fake = fakeTerminal();
  const box = { terminal: fake.terminal as CaptainTerminal | undefined };
  const captain = new TuiCaptain(f.store, id => (id === sessionId ? box.terminal : undefined), { poll: 2, submit: 2 });
  t.after(() => captain.close());
  return { f, fake, box, captain, inbox: () => f.store.snapshot().tuiDetails?.[sessionId]?.inbox ?? [] };
}
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await pause(2); assert.ok(check(), 'timed out'); };

test('a team message waits for the terminal and an empty prompt, then is pasted and submitted without its receipt', async t => {
  const { fake, box, captain, inbox } = await setup(t);
  box.terminal = undefined;
  await captain.deliver('tui', ['AgentTeams inbox receipt: {"teamId":"x","ids":["1"]}\n\nAgentTeams message from member coder:\n\nDone\u001b[201~.']);
  assert.equal(captain.waiting('tui'), 1);
  await pause(15);
  assert.equal(inbox().length, 1, 'no terminal yet');
  box.terminal = fake.terminal;
  fake.state.lines = [line('❯ half a thought', { inverse: 16 })];
  await pause(15);
  assert.deepEqual(fake.state.writes, [], 'a draft holds it');
  fake.state.lines = [line('   ❯ 1. Yes'), line('     2. No')];
  await pause(15);
  assert.deepEqual(fake.state.writes, [], 'so does a dialog');
  fake.state.lines = [line('❯')];
  await until(() => inbox().length === 0);
  assert.deepEqual(fake.state.writes, ['\u001b[200~AgentTeams message from member coder:\n\nDone[201~.\u001b[201~', '\r'], 'nothing inside can end the paste early');
  assert.equal(captain.waiting('tui'), 0);
});

test('messages go one at a time, in order, each on a prompt that stayed empty', async t => {
  const { fake, captain, inbox } = await setup(t);
  await captain.deliver('tui', ['one', ' ', 'two']);
  assert.deepEqual(inbox(), ['one', 'two'], 'nothing is queued for blank text');
  await until(() => inbox().length === 0);
  assert.deepEqual(fake.state.writes, ['\u001b[200~one\u001b[201~', '\r', '\u001b[200~two\u001b[201~', '\r']);
});

test('a paste cleared by a key pressed meanwhile is not submitted and stays queued', async t => {
  const { fake, captain, inbox } = await setup(t);
  fake.state.loses = 1;
  await captain.deliver('tui', ['one']);
  await until(() => fake.state.writes.includes('\r'));
  assert.deepEqual(fake.state.writes, ['\u001b[200~one\u001b[201~', '\u001b[200~one\u001b[201~', '\r'], 'Enter only after the paste that stayed');
  await until(() => inbox().length === 0);
});

test('messages survive a restart, and an older row with no saved details still gets them', async t => {
  const { f, fake, captain } = await setup(t);
  fake.state.lines = [line('Resuming session…')];
  await captain.deliver('tui', ['one']);
  captain.close();
  const next = fakeTerminal();
  const restarted = new TuiCaptain(f.store, () => next.terminal, { poll: 2, submit: 2 });
  t.after(() => restarted.close());
  await until(() => next.state.writes.includes('\r'));
  assert.deepEqual(next.state.writes[0], '\u001b[200~one\u001b[201~');
  await f.store.update(s => { s.tuiSessions = ['old']; s.tuiDetails = {}; });
  await restarted.deliver('old', ['two']);
  await until(() => next.state.writes.at(-2) === '\u001b[200~two\u001b[201~');
});

test('a /team line starts the team through DSH and tells the CLI, leading with what titles the conversation', async t => {
  const { captain, inbox, fake } = await setup(t);
  fake.state.lines = [line('❯ /team solo fix it', { inverse: 18 })];
  const signal = new AbortController().signal;
  await assert.rejects(captain.team('chat', 'solo fix it', signal), /not a TUI/);
  await assert.rejects(captain.team('tui', 'solo fix it', signal), /still starting/);
  const lines: string[] = [];
  let result: TeamResult = { kind: 'error', text: 'needs the plugin' };
  captain.startTeam = async (id, text) => { lines.push(`${id}: ${text}`); return result; };
  await assert.rejects(captain.team('tui', 'solo fix it', signal), /needs the plugin/);
  assert.deepEqual(inbox(), [], 'a failure tells the CLI nothing');
  result = { kind: 'success', text: 'Team "fix it" started (1 member, 1 task): coder.' };
  assert.equal(await captain.team('tui', 'solo fix it', signal), result.text);
  assert.deepEqual(lines, ['tui: solo fix it', 'tui: solo fix it']);
  assert.equal(inbox().length, 1);
  assert.ok(inbox()[0].startsWith('Team "fix it" started'));
  assert.ok(inbox()[0].includes(CAPTAIN_GUIDE));
});

test('the turn AgentTeams wakes a TUI captain with goes to its terminal and starts no CLI', async t => {
  const delivered: string[][] = [];
  const adapter = new RemoteCliAdapter({} as ChatProjects, { agent: () => undefined, step: () => undefined, terminal: id => (id === 'tui' ? async messages => { delivered.push([...messages]); } : undefined) });
  const team = (text: string) => createUserMessage({ source: { kind: 'agent-teams' }, content: [{ type: 'text', text }] } as unknown as Parameters<typeof createUserMessage>[0]);
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Handed to the terminal.' }] };
  const run = async (options: Partial<GenerateOptions>) => { const out: { type: string; text?: string }[] = []; for await (const chunk of adapter.stream({ sessionId: 'tui', provider: 'remote-cli-claude', model: 'x', messages: [], ...options } as unknown as GenerateOptions)) out.push(chunk as { type: string }); return out; };
  const out = await run({ messages: [team('old report'), assistant, team('first'), createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'context DSH added' }] }), team('second')] as unknown as GenerateOptions['messages'] });
  assert.deepEqual(delivered, [['first', 'second']], 'only what came after the last reply, and only the team\'s');
  assert.deepEqual(out.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'], 'the turn ends at once');
  await run({ purpose: 'compaction', messages: [team('old report')] as unknown as GenerateOptions['messages'] });
  assert.equal(delivered.length, 1, 'maintenance is not a report');
  const title = await run({ purpose: 'session-title', messages: [team('A title')] as unknown as GenerateOptions['messages'] });
  assert.equal(title.find(chunk => chunk.type === 'text-delta')?.text, 'A title', 'and a title is still a title');
  await assert.rejects(run({ sessionId: undefined, messages: [team('x')] as unknown as GenerateOptions['messages'] }), /Select a remote CLI/);
});

test('the prompt\'s text is read back from the screen as it was typed, across wrapped rows', () => {
  const claude = ['❯ Earlier message', '⏺ reply', '─'.repeat(50), '❯ /team pair coder=codex reviewer=claude/opus Fix the', '  login timeout in the auth module', '─'.repeat(50), '  ⏵⏵ auto mode on'];
  assert.equal(promptText(claude), '/team pair coder=codex reviewer=claude/opus Fix the login timeout in the auth module');
  const codex = ['› /team solo make hold-', '  codex-541618.txt and', '  coder=codex/', '  gpt-5.6-luna', '', '  GPT-6 medium · ~/app'];
  assert.equal(promptText(codex), '/team solo make hold-codex-541618.txt and coder=codex/gpt-5.6-luna', 'Codex breaks after hyphens and slashes, with no space to restore');
  assert.equal(promptText(['› /team solo 请在项目根目录创建名为', '  a.txt 的文件，内容只写一', '  行', '  GPT-6 medium · ~/app']), '/team solo 请在项目根目录创建名为a.txt 的文件，内容只写一行', 'nor between Chinese characters');
  assert.equal(promptText(['no prompt here']), '');
  assert.equal(teamLine('/team solo fix it'), 'solo fix it');
  assert.equal(teamLine('/team'), '', 'on its own it gets the usage');
  assert.equal(teamLine('/teams now'), undefined);
  assert.equal(teamLine('tell the /team about it'), undefined);
  assert.equal(teamLine(''), undefined);
});
