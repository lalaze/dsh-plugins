import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Activity, lastLine } from '../src/activity.js';
import { flowText, runFlow, type ChildRequest, type ChildResult } from '../src/engine.js';
import { parseLine } from '../src/line.js';
import { parseVerdict } from '../src/prompts.js';
import { relocate, resolveSpec, type CatalogModel, type Routes } from '../src/routes.js';
import { parseRow, rowText } from '../src/shared.js';
import { ReportStore } from '../src/store.js';

const route = (label: string) => ({ provider: 'p', model: label, label });
const routes: Routes = { plan: route('planner'), implement: route('coder'), review: route('checker') };
const done = (text: string): ChildResult => ({ text, stopReason: 'completed' });

/** Runs the flow against scripted model replies and records the order of the steps. */
async function play(script: ((request: ChildRequest) => ChildResult | Promise<ChildResult>), input: Partial<Parameters<typeof runFlow>[0]> = {}) {
  const calls: ChildRequest[] = [], notes: string[] = [], reports: string[] = [], rows: { running: string; closed?: { kind: string; title: string; body?: string } }[] = [];
  const outcome = await runFlow({ goal: 'add csv', routes, rounds: 3, signal: new AbortController().signal, ...input }, {
    run: async request => { calls.push(request); return script(request); },
    note: async text => { notes.push(text); },
    report: text => { reports.push(text); },
    openRow: running => {
      const row: (typeof rows)[number] = { running };
      rows.push(row);
      return { attach: () => undefined, close: async result => { row.closed = result; } };
    },
  });
  return { outcome, calls, notes, rows, reports, order: calls.map(call => `${call.role}${call.round || ''}`) };
}
const reviewing = (verdicts: string[]) => {
  let index = 0;
  return (request: ChildRequest) => request.role === 'review' ? done(verdicts[index++]) : done(`${request.role} output`);
};

test('a passing review ends the flow after one round', async () => {
  const { outcome, order, calls } = await play(reviewing(['All good.\nFLOW_VERDICT: pass']));
  assert.deepEqual(outcome, { status: 'passed', round: 1 });
  assert.deepEqual(order, ['plan', 'implement1', 'review1']);
  assert.deepEqual(calls.map(call => call.readOnly), [true, false, true]);
  assert.match(calls[1].prompt, /plan output/);
  assert.match(calls[2].prompt, /implement output/);
});
test('rejected work goes back with the findings and is reviewed again', async () => {
  const { outcome, order, calls, rows } = await play(reviewing(['csv.js: no header row\nFLOW_VERDICT: needs_revision', 'FLOW_VERDICT: pass']));
  assert.deepEqual(outcome, { status: 'passed', round: 2 });
  assert.deepEqual(order, ['plan', 'implement1', 'review1', 'implement2', 'review2']);
  assert.match(calls[3].prompt, /no header row/);
  assert.doesNotMatch(calls[3].prompt, /FLOW_VERDICT/);
  assert.match(calls[3].prompt, /do not start over/);
  assert.match(calls[4].prompt, /no header row/);
  assert.ok(rows.some(row => /sent it back/.test(row.closed!.title) && /no header row/.test(row.closed!.body!)));
});
test('the rounds run out and the last findings go to the user', async () => {
  const { outcome, order, notes } = await play(reviewing(Array(9).fill('still broken\nFLOW_VERDICT: needs_revision')), { rounds: 2 });
  assert.deepEqual(outcome, { status: 'rejected', rounds: 2, findings: 'still broken' });
  assert.deepEqual(order, ['plan', 'implement1', 'review1', 'implement2', 'review2']);
  assert.match(notes.at(-1)!, /did not pass after 2 rounds[\s\S]*still broken/);
});
test('planning can be skipped', async () => {
  const { order } = await play(reviewing(['FLOW_VERDICT: pass']), { routes: { implement: routes.implement, review: routes.review } });
  assert.deepEqual(order, ['implement1', 'review1']);
});
test('a review with no verdict is asked again without redoing the work', async () => {
  const { outcome, order, calls } = await play(reviewing(['looks fine to me', 'FLOW_VERDICT: pass']));
  assert.deepEqual(outcome, { status: 'passed', round: 1 });
  assert.deepEqual(order, ['plan', 'implement1', 'review1', 'review1']);
  assert.match(calls[3].prompt, /left that line out/);
});
test('two reviews with no verdict stop the flow rather than counting as a pass', async () => {
  const { outcome, order } = await play(reviewing(['fine', 'fine']));
  assert.deepEqual(outcome, { status: 'failed', reason: 'no verdict' });
  assert.deepEqual(order, ['plan', 'implement1', 'review1', 'review1']);
});
test('a failed step ends the flow and says why', async () => {
  const { outcome, order, rows } = await play(request => request.role === 'implement' ? { text: '', stopReason: 'error', diagnostic: 'quota' } : done('x'));
  assert.deepEqual(outcome, { status: 'failed', reason: 'quota' });
  assert.deepEqual(order, ['plan', 'implement1']);
  assert.deepEqual(rows.at(-1)!.closed, { kind: 'error', title: 'Implement failed: quota' });
});
test('a thrown error from starting a child is reported', async () => {
  const { outcome, rows } = await play(() => { throw new Error('limit reached'); });
  assert.deepEqual(outcome, { status: 'failed', reason: 'limit reached' });
  assert.match(rows.at(-1)!.closed!.title, /limit reached/);
});
test('stopping during a step ends the flow with no further steps', async () => {
  const controller = new AbortController();
  const { outcome, order, notes, rows } = await play(request => { if (request.role === 'implement') controller.abort(); return done('x'); }, { signal: controller.signal });
  assert.deepEqual(outcome, { status: 'stopped' });
  assert.deepEqual(order, ['plan', 'implement1']);
  assert.ok(!notes.some(note => /Stopped/.test(note)), 'the stop command says so itself');
  assert.match(rows.at(-1)!.closed!.title, /^Round 1: Implement stopped/);
});
test('notes follow the language of the goal', async () => {
  const { notes } = await play(reviewing(['FLOW_VERDICT: pass']), { goal: '给导出加 CSV' });
  assert.match(notes.at(-1)!, /^完成：第 1 轮审核通过/);
});

test('a sent-back row shows the closing message, while the implementer gets the whole review', async () => {
  let reviews = 0;
  const { calls, rows } = await play(request => {
    if (request.role !== 'review') return done('x');
    return ++reviews === 1
      ? { text: 'Earlier detail: csv.js:3 is wrong.\n\nFix csv.js.\nFLOW_VERDICT: needs_revision', closing: 'Fix csv.js.\nFLOW_VERDICT: needs_revision', stopReason: 'completed' }
      : done('FLOW_VERDICT: pass');
  });
  assert.match(calls.find(call => call.role === 'implement' && call.round === 2)!.prompt, /csv\.js:3 is wrong/);
  const row = rows.find(row => /sent it back/.test(row.closed!.title))!.closed!;
  assert.equal(row.body, 'Fix csv.js.');
});
test('the closing note leaves out the progress sentences and the verdict', async () => {
  const { notes } = await play(request => request.role === 'review'
    ? { text: 'Checking the diff.\n\nAll criteria met.\nFLOW_VERDICT: pass', closing: 'All criteria met.\nFLOW_VERDICT: pass', stopReason: 'completed' }
    : done('x'));
  assert.match(parseRow(notes.at(-1)!).body!, /All criteria met\.$/);
  assert.doesNotMatch(notes.at(-1)!, /Checking the diff|FLOW_VERDICT/);
});

test('the last verdict line decides and Markdown around it is ignored', () => {
  assert.equal(parseVerdict('**FLOW_VERDICT: pass**').verdict, 'pass');
  assert.equal(parseVerdict('Format is FLOW_VERDICT: pass here\nbad\nFLOW_VERDICT: needs_revision').verdict, 'needs_revision');
  assert.equal(parseVerdict('first\nFLOW_VERDICT: needs_revision\nFLOW_VERDICT: pass').verdict, 'pass');
  assert.equal(parseVerdict('The verdict FLOW_VERDICT: pass is what I would write').verdict, undefined);
  assert.equal(parseVerdict('no line').verdict, undefined);
  assert.equal(parseVerdict('a problem\nFLOW_VERDICT: needs_revision').body, 'a problem');
});

test('the line takes options first and everything after them is the goal', () => {
  assert.deepEqual(parseLine(' impl=codex review=claude/haiku@high rounds=2 add plan=x support\nfor csv'), { kind: 'run', goal: 'add plan=x support\nfor csv', overrides: { implement: 'codex', review: 'claude/haiku@high' }, rounds: 2 });
  assert.deepEqual(parseLine(' plan=off fix it'), { kind: 'run', goal: 'fix it', overrides: { plan: 'off' } });
  assert.deepEqual(parseLine('  '), { kind: 'status' });
  assert.deepEqual(parseLine(' stop'), { kind: 'stop' });
  assert.deepEqual(parseLine(' stop the bleeding'), { kind: 'run', goal: 'stop the bleeding', overrides: {} });
  assert.throws(() => parseLine(' impl=codex'), /Say what to do/);
  assert.throws(() => parseLine(' rounds=0 x'), /rounds must be/);
});

test('an empty goal runs only when attachments are present', () => {
  assert.deepEqual(parseLine(''), { kind: 'status' });
  assert.deepEqual(parseLine('', true), { kind: 'run', goal: '', overrides: {} });
  assert.deepEqual(parseLine('impl=codex', true), { kind: 'run', goal: '', overrides: { implement: 'codex' } });
  assert.throws(() => parseLine('impl=codex'), /Say what to do/);
});

test('the started row adds attachment counts only when present', () => {
  const en = flowText('add csv').started, zh = flowText('加 CSV').started;
  assert.equal(en(routes, 3), 'Started: Plan planner → Implement coder → Review checker, up to 3 review rounds');
  assert.equal(zh(routes, 3), '已开始：计划 planner → 实现 coder → 审核 checker，最多审核 3 轮');
  assert.equal(en(routes, 3, 0), en(routes, 3));
  assert.equal(en(routes, 3, 2), `${en(routes, 3)}, 2 attachments`);
  assert.equal(zh(routes, 3, 2), `${zh(routes, 3)}，2 个附件`);
});

const catalog: CatalogModel[] = [
  { provider: 'remote-cli-codex', providerName: 'Codex', id: 'mini/codex/gpt-sol', name: 'GPT Sol · Mini' },
  { provider: 'remote-cli-codex', providerName: 'Codex', id: 'mini/codex/gpt-terra', name: 'GPT Terra · Mini' },
  { provider: 'remote-cli-codex', providerName: 'Codex', id: 'air/codex/gpt-sol', name: 'GPT Sol · Air' },
  { provider: 'remote-cli-claude', providerName: 'Claude', id: 'mini/claude/haiku', name: 'Haiku · Mini' },
  { provider: 'local-qwen', providerName: 'Qwen', id: 'local-current', name: 'Qwen Flash' },
];
test('words on the line resolve to models, preferring the conversation\'s machine', () => {
  assert.equal(resolveSpec('codex', catalog).model, 'mini/codex/gpt-sol');
  assert.equal(resolveSpec('codex', catalog, 'air').model, 'air/codex/gpt-sol');
  assert.equal(resolveSpec('codex/gpt-sol', catalog, 'air').model, 'air/codex/gpt-sol');
  assert.equal(resolveSpec('codex/terra', catalog).model, 'mini/codex/gpt-terra');
  assert.equal(resolveSpec('haiku', catalog).model, 'mini/claude/haiku');
  assert.equal(resolveSpec('qwen', catalog).provider, 'local-qwen');
  assert.equal(resolveSpec('claude/haiku@high', catalog).effort, 'high');
});
test('an unclear word is refused rather than guessed', () => {
  assert.throws(() => resolveSpec('gpt', catalog), /several models/);
  assert.throws(() => resolveSpec('nothing', catalog), /No model matches/);
});
test('a saved model moves to the conversation\'s machine only when that machine has it', () => {
  const saved = { provider: 'remote-cli-codex', model: 'mini/codex/gpt-sol', label: 'GPT Sol · Mini' };
  assert.equal(relocate(saved, catalog, 'air').model, 'air/codex/gpt-sol');
  assert.equal(relocate(saved, catalog, 'mini').model, 'mini/codex/gpt-sol');
  assert.equal(relocate(saved, catalog).model, 'mini/codex/gpt-sol');
  const terra = { ...saved, model: 'mini/codex/gpt-terra' };
  assert.equal(relocate(terra, catalog, 'air').model, 'mini/codex/gpt-terra');
});
test('every step is one row, from what is running to its result', async () => {
  const clock = { at: 0 };
  const { rows } = await play(request => {
    clock.at += 125_000;
    if (request.role === 'review') return { text: 'Looks right.\n\nFine.\nFLOW_VERDICT: pass', closing: 'Fine.\nFLOW_VERDICT: pass', stopReason: 'completed' };
    return { text: 'progress\n\nthe result', closing: 'the result', stopReason: 'completed' };
  }, { goal: '给导出加 CSV' });
  assert.deepEqual(rows.map(row => row.running), ['计划中 · planner', '第 1 轮：实现中 · coder', '第 1 轮：审核中 · checker']);
  assert.deepEqual(rows.map(row => row.closed!.kind), ['success', 'success', 'success']);
  assert.match(rows[0].closed!.title, /^计划完成（/);
  assert.equal(rows[0].closed!.body, 'the result');
  assert.match(rows[1].closed!.title, /^第 1 轮：实现完成（/);
  assert.match(rows[2].closed!.title, /^第 1 轮：审核通过（/);
  assert.equal(rows[2].closed!.body, 'Fine.');
});
test('a review with no verdict says it is asked again, in its own row', async () => {
  const { rows } = await play(reviewing(['no verdict here', 'FLOW_VERDICT: pass']));
  assert.match(rows[2].closed!.title, /no verdict, so it is asked again/);
  assert.match(rows[3].closed!.title, /review passed/);
});
test('a row keeps its title, its result and the conversation behind it', () => {
  const text = rowText({ title: '计划完成（3 分）', body: '# Plan\n\n1. one\n', parentId: 'p-1', childId: 'c-1' });
  assert.deepEqual(parseRow(text), { title: '计划完成（3 分）', body: '# Plan\n\n1. one', parentId: 'p-1', childId: 'c-1' });
  assert.deepEqual(parseRow('已开始：a → b\ngoal'), { title: '已开始：a → b', body: 'goal' });
  assert.deepEqual(parseRow('Stopped'), { title: 'Stopped' });
  assert.deepEqual(parseRow(rowText({ title: 'x', parentId: 'p', childId: 'c' })), { title: 'x', parentId: 'p', childId: 'c' });
  assert.deepEqual(parseRow(rowText({ title: 'x', body: 'y', open: true })), { title: 'x', body: 'y', open: true });
  assert.deepEqual(parseRow('x\n<!-- flow-row {nope} -->'), { title: 'x' }, 'a model writing this line does not break the row');
  assert.ok(rowText({ title: 'x', body: 'y'.repeat(50000) }).length < 41000, 'a huge result does not bloat the log');
});
test('the activity line is the last thing the model said, whichever kind of chunk carried it', () => {
  const activity = new Activity();
  assert.equal(activity.current(), '');
  activity.push({ type: 'text-delta', index: 0, text: 'First I read the code.\n\n' });
  activity.push({ type: 'text-delta', index: 0, text: '**Now** running `pnpm test`' });
  assert.equal(activity.current(), 'Now running pnpm test');
  activity.push({ type: 'reasoning-delta', index: 1, text: 'Checking the diff\n```\n' });
  assert.equal(activity.current(), 'Checking the diff');
  activity.push({ type: 'tool-call-delta', index: 2, name: 'write_file' });
  activity.push({ type: 'tool-call-delta', index: 2 });
  assert.equal(activity.current(), 'write_file');
});
test('a remote CLI tool line shows as plain text and goes when its block is closed again', () => {
  const activity = new Activity();
  activity.push({ type: 'text-delta', index: 0, text: 'Reading it.' });
  activity.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'Reading it.' } });
  activity.push({ type: 'text-delta', index: 0, text: '\n\n[工具调用 · 运行 a\\_b\\[0\\]](https://remote-agents.invalid/running-tool)' });
  assert.equal(activity.current(), '工具调用 · 运行 a_b[0]');
  activity.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'Reading it.' } });
  assert.equal(activity.current(), 'Reading it.');
});
test('a new attempt keeps the last line until it has its own, and long lines are cut', () => {
  const activity = new Activity();
  activity.push({ type: 'text-delta', index: 0, text: 'before the retry' });
  activity.restart();
  assert.equal(activity.current(), 'before the retry');
  activity.push({ type: 'text-delta', index: 0, text: 'after' });
  assert.equal(activity.current(), 'after');
  assert.equal([...lastLine('x'.repeat(500))].length, 201);
  assert.equal(lastLine('text\n---\n\n'), 'text');
});
test('the last row reports what was built and what the review found, open without a click', async () => {
  const { notes } = await play(request => request.role === 'review'
    ? { text: 'Checked.\n\nAll met.\nFLOW_VERDICT: pass', closing: 'All met.\nFLOW_VERDICT: pass', stopReason: 'completed' }
    : { text: 'working\n\nAdded subtract.', closing: 'Added subtract.', stopReason: 'completed' });
  const row = parseRow(notes.at(-1)!);
  assert.match(row.title, /^Done: review passed in round 1/);
  assert.equal(row.open, true);
  assert.match(row.body!, /Added subtract\.[\s\S]*All met\.$/);
});
test('the conversation model is told how the flow ended, whichever way it ended', async () => {
  const passed = await play(reviewing(['Good.\nFLOW_VERDICT: pass']));
  assert.match(passed.reports[0], /add csv[\s\S]*review passed in round 1[\s\S]*implement output[\s\S]*Good\./);
  const rejected = await play(reviewing(['Bad.\nFLOW_VERDICT: needs_revision']), { rounds: 1 });
  assert.match(rejected.reports[0], /still rejected the work after 1 round,[\s\S]*Bad\./);
  const failed = await play(request => request.role === 'implement' ? { text: '', stopReason: 'error', diagnostic: 'quota' } : done('x'));
  assert.match(failed.reports[0], /implement step failed: quota/);
  const controller = new AbortController();
  const stopped = await play(request => { if (request.role === 'implement') controller.abort(); return done('x'); }, { signal: controller.signal });
  assert.match(stopped.reports[0], /stopped it during the implement step/);
  assert.equal(passed.reports.length + rejected.reports.length + failed.reports.length + stopped.reports.length, 4);
});
test('a flow result waits for the next message across restarts, and is told once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flow-reports-')), file = join(dir, 'reports.json');
  try {
    const store = new ReportStore(file);
    await store.open();
    store.put('s1', 'first');
    store.put('s1', 'second');
    await store.flush();
    const reopened = new ReportStore(file);
    await reopened.open();
    assert.equal(reopened.take('s2'), undefined);
    assert.equal(reopened.take('s1'), 'second');
    assert.equal(reopened.take('s1'), undefined);
    await reopened.flush();
    const again = new ReportStore(file);
    await again.open();
    assert.equal(again.take('s1'), undefined, 'told once, even after another restart');
    await again.flush();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
