import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowText, runFlow, type ChildRequest, type ChildResult } from '../src/engine.js';
import { parseLine } from '../src/line.js';
import { parseVerdict } from '../src/prompts.js';
import { relocate, resolveSpec, type CatalogModel, type Routes } from '../src/routes.js';

const route = (label: string) => ({ provider: 'p', model: label, label });
const routes: Routes = { plan: route('planner'), implement: route('coder'), review: route('checker') };
const done = (text: string): ChildResult => ({ text, stopReason: 'completed' });

/** Runs the flow against scripted model replies and records the order of the steps. */
async function play(script: ((request: ChildRequest) => ChildResult | Promise<ChildResult>), input: Partial<Parameters<typeof runFlow>[0]> = {}) {
  const calls: ChildRequest[] = [], notes: string[] = [];
  const outcome = await runFlow({ goal: 'add csv', routes, rounds: 3, signal: new AbortController().signal, ...input }, {
    run: async request => { calls.push(request); return script(request); },
    note: async text => { notes.push(text); },
  });
  return { outcome, calls, notes, order: calls.map(call => `${call.role}${call.round || ''}`) };
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
  const { outcome, order, calls, notes } = await play(reviewing(['csv.js: no header row\nFLOW_VERDICT: needs_revision', 'FLOW_VERDICT: pass']));
  assert.deepEqual(outcome, { status: 'passed', round: 2 });
  assert.deepEqual(order, ['plan', 'implement1', 'review1', 'implement2', 'review2']);
  assert.match(calls[3].prompt, /no header row/);
  assert.doesNotMatch(calls[3].prompt, /FLOW_VERDICT/);
  assert.match(calls[3].prompt, /do not start over/);
  assert.match(calls[4].prompt, /no header row/);
  assert.ok(notes.some(note => /sent it back/.test(note) && /no header row/.test(note)));
});
test('the rounds run out and the last findings go to the user', async () => {
  const { outcome, order, notes } = await play(reviewing(Array(9).fill('still broken\nFLOW_VERDICT: needs_revision')), { rounds: 2 });
  assert.deepEqual(outcome, { status: 'rejected', rounds: 2, findings: 'still broken' });
  assert.deepEqual(order, ['plan', 'implement1', 'review1', 'implement2', 'review2']);
  assert.match(notes.at(-1)!, /did not pass after 2 rounds.*still broken/);
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
  const { outcome, order, notes } = await play(request => request.role === 'implement' ? { text: '', stopReason: 'error', diagnostic: 'quota' } : done('x'));
  assert.deepEqual(outcome, { status: 'failed', reason: 'quota' });
  assert.deepEqual(order, ['plan', 'implement1']);
  assert.match(notes.at(-1)!, /Implement failed: quota/);
});
test('a thrown error from starting a child is reported', async () => {
  const { outcome, notes } = await play(() => { throw new Error('limit reached'); });
  assert.deepEqual(outcome, { status: 'failed', reason: 'limit reached' });
  assert.match(notes.at(-1)!, /limit reached/);
});
test('stopping during a step ends the flow with no further steps', async () => {
  const controller = new AbortController();
  const { outcome, order, notes } = await play(request => { if (request.role === 'implement') controller.abort(); return done('x'); }, { signal: controller.signal });
  assert.deepEqual(outcome, { status: 'stopped' });
  assert.deepEqual(order, ['plan', 'implement1']);
  assert.ok(!notes.some(note => /Stopped/.test(note)), 'the stop command says so itself');
});
test('notes follow the language of the goal', async () => {
  const { notes } = await play(reviewing(['FLOW_VERDICT: pass']), { goal: '给导出加 CSV' });
  assert.match(notes.at(-1)!, /^完成：第 1 轮审核通过/);
});

test('a sent-back row shows the closing message, while the implementer gets the whole review', async () => {
  let reviews = 0;
  const { calls, notes } = await play(request => {
    if (request.role !== 'review') return done('x');
    return ++reviews === 1
      ? { text: 'Earlier detail: csv.js:3 is wrong.\n\nFix csv.js.\nFLOW_VERDICT: needs_revision', closing: 'Fix csv.js.\nFLOW_VERDICT: needs_revision', stopReason: 'completed' }
      : done('FLOW_VERDICT: pass');
  });
  assert.match(calls.find(call => call.role === 'implement' && call.round === 2)!.prompt, /csv\.js:3 is wrong/);
  const row = notes.find(note => /sent it back/.test(note))!;
  assert.match(row, /Fix csv\.js\.$/);
  assert.doesNotMatch(row, /Earlier detail/);
});
test('the closing note leaves out the progress sentences and the verdict', async () => {
  const { notes } = await play(request => request.role === 'review'
    ? { text: 'Checking the diff.\n\nAll criteria met.\nFLOW_VERDICT: pass', closing: 'All criteria met.\nFLOW_VERDICT: pass', stopReason: 'completed' }
    : done('x'));
  assert.match(notes.at(-1)!, /All criteria met\.$/);
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
