import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { apply, type ModelFlowService } from '../src/index.js';
import { attachmentNote, implementPrompt, planPrompt, reviewPrompt } from '../src/prompts.js';
import { parseRow, type LiveCard } from '../src/shared.js';

const attachments = [
  { type: 'image' as const, attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', width: 16, height: 16, bytes: 97, name: 'image.png' } },
  { type: 'file' as const, attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'goal.txt', bytes: 10 } },
];
type Block = { type: string; text?: string };
interface Invocation { commandId?: string; agent: typeof agent; rawInput: string; attachments?: readonly { type: 'image' | 'file' }[] }
interface Reply { kind: 'success' | 'error'; text?: string }
interface Command { input: { attachments?: boolean }; handler(input: Invocation): Promise<Reply> }
interface ActivationSpec { childId: string; label: string; signal: AbortSignal; request: { prompt: Block[]; agentOptions: { model: string } } }
const agent = { id: 'parent', phase: { kind: 'idle', lastTurn: 1 }, session: { header: {}, append() {}, deriveMessages: () => [] } };
const options = 'plan=planner impl=coder review=checker';
const models = ['planner', 'coder', 'checker'].map(id => ({ provider: 'p', id, name: id }));

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail('flow did not reach the expected state');
}

async function setup(t: TestContext, settings: {
  verdicts?: string[];
  info?: (model: string) => Promise<{ inputModalities?: readonly string[] }>;
  pending?: boolean;
  /** Boot again in an earlier setup's home, as DSH does after a restart. */
  home?: string;
  /** Other plugins' services, by name. */
  services?: Record<string, unknown>;
  /** More of the saved settings. */
  config?: Record<string, unknown>;
} = {}) {
  const home = settings.home ?? await mkdtemp(join(tmpdir(), 'model-flow-attachments-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers: (() => void)[] = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose();
    await delay(10);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    // A flow that has just ended may still be saving its card into the folder.
    if (!settings.home) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const route = (model: string) => ({ provider: 'p', model, label: model });
  const directory = join(home, 'storages', 'dsh-model-flow');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), JSON.stringify({ plan: route('planner'), implement: route('coder'), review: route('checker'), rounds: 3, ...settings.config }));
  let command!: Command, fetch!: (request: Request) => Promise<Response>, service!: ModelFlowService, reviews = 0, disposed = 0, commands = 0;
  const calls: ActivationSpec[] = [], notes: string[] = [], resolved: string[] = [];
  const ctx = {
    connection: { fetch: { register(definition: { fetch: typeof fetch }) { fetch = definition.fetch; } } },
    effect(callback: () => (() => void)) { disposers.push(callback()); },
    on() {}, get(name: string) { return settings.services?.[name]; },
    provide(name: string, value: ModelFlowService) { if (name === 'modelFlow') service = value; },
    commands: {
      register(definition: Command) { command = definition; return () => {}; },
      async execute(parent: typeof agent, line: string) {
        const commandId = `command-${++commands}`;
        const reply = await command.handler({ commandId, agent: parent, rawInput: line.slice('/flow '.length) });
        notes.push(reply.text ?? '');
        return reply;
      },
    },
    llm: {
      listProviders: () => [{ id: 'p', name: 'Models' }], listModels: async () => models,
      async resolveModelInfo(_provider: string, model: string) {
        resolved.push(model);
        return settings.info ? settings.info(model) : { inputModalities: ['text', 'image'] };
      },
    },
    subagents: {
      getProvider: (name: string) => (name === 'spawn' ? {} : undefined),
      async startActivation(spec: ActivationSpec) {
        calls.push(spec);
        const text = spec.label.startsWith('flow · review') ? (settings.verdicts ?? ['FLOW_VERDICT: pass'])[reviews++] : `${spec.request.agentOptions.model} output`;
        return {
          childId: `child-${calls.length}`,
          result: settings.pending ? new Promise<never>(() => {}) : Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          async dispose() { disposed++; },
        };
      },
    },
  };
  await apply(ctx as unknown as Context);
  return {
    command, calls, notes, resolved, home, disposed: () => disposed, service, agent,
    run: (rawInput: string, blocks: Invocation['attachments'] = attachments) => command.handler({ agent, rawInput, attachments: blocks }),
    async post(body: Record<string, unknown>) {
      const response = await fetch(new Request('http://test/flow', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Model-Flow': '1' }, body: JSON.stringify(body) }));
      assert.equal(response.status, 200);
      return response.json();
    },
    async locale(locale: string) {
      const response = await fetch(new Request('http://test/flow', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Model-Flow': '1' }, body: JSON.stringify({ action: 'locale', locale }) }));
      assert.equal(response.status, 200);
    },
    async finished() {
      await until(() => notes.some(note => /^(Done:|完成：)/u.test(note)));
      await delay(0);
    },
  };
}

function assertAttachments(calls: ActivationSpec[]) {
  for (const call of calls) {
    assert.equal(call.request.prompt.length, 3);
    assert.equal(call.request.prompt[0].type, 'text');
    assert.ok(call.request.prompt[0].text!.endsWith(attachmentNote));
    assert.deepEqual(call.request.prompt.slice(1), attachments);
    assert.equal(call.request.prompt[1], attachments[0]);
    assert.equal(call.request.prompt[2], attachments[1]);
  }
}

test('all steps and revision rounds receive the image and file in order', async t => {
  const host = await setup(t, { verdicts: ['fix it\nFLOW_VERDICT: needs_revision', 'FLOW_VERDICT: pass'] });
  assert.equal(host.command.input.attachments, true);
  assert.equal((await host.run(`${options} do it`)).kind, 'success');
  await host.finished();
  assert.deepEqual(host.calls.map(call => call.label), ['flow · plan', 'flow · implement 1', 'flow · review 1', 'flow · implement 2', 'flow · review 2']);
  assert.deepEqual(host.resolved, ['planner', 'coder', 'checker']);
  assertAttachments(host.calls);
});

test('a review asked again for its verdict receives the same attachments', async t => {
  const host = await setup(t, { verdicts: ['looks good', 'FLOW_VERDICT: pass'] });
  await host.run(`${options} do it`);
  await host.finished();
  assert.equal(host.calls.length, 4);
  assert.match(host.calls[3].request.prompt[0].text!, /left that line out/);
  assertAttachments(host.calls);
});

test('stop with attachments and a duplicate flow fail without stopping the running flow', async t => {
  const host = await setup(t, { pending: true });
  assert.equal((await host.run(`${options} do it`, [])).kind, 'success');
  const stopped = await host.run('stop');
  assert.equal(stopped.kind, 'error');
  assert.match(stopped.text!, /Remove the attachments/);
  assert.equal((await host.run(`${options} another task`)).kind, 'error');
  assert.equal(host.calls.length, 0, 'neither error starts a child');
  await until(() => host.calls.length === 1);
  assert.equal(host.calls[0].signal.aborted, false);
  assert.equal(host.disposed(), 0);
  assert.equal((await host.run('stop', [])).kind, 'success');
  assert.equal(host.calls[0].signal.aborted, true);
  assert.equal(host.disposed(), 1);
});

test('the stop button on a running card ends its flow and nothing else', async t => {
  const host = await setup(t, { pending: true });
  await host.run(`${options} do it`, []);
  await until(() => host.calls.length === 1);
  // The one command the flow runs itself is its card.
  const row = 'command-1';
  const card = async () => (await host.post({ action: 'card', commandId: row }) as { card?: LiveCard }).card;
  await until(async () => (await card())?.steps.length === 1);
  assert.deepEqual(await host.post({ action: 'stop', commandId: 'no-such-row' }), { stopped: false });
  assert.equal(host.calls[0].signal.aborted, false);
  assert.deepEqual(await host.post({ action: 'stop', commandId: row }), { stopped: true });
  assert.equal(host.calls[0].signal.aborted, true);
  assert.equal(host.disposed(), 1);
  await until(async () => (await card())?.end?.kind === 'stopped');
  assert.equal((await card())!.steps[0].status, 'stopped');
  assert.deepEqual(await host.post({ action: 'stop', commandId: row }), { stopped: false }, 'the flow is over');
  assert.equal(host.calls.length, 1, 'no further step starts');
  assert.equal((await host.run('stop', [])).kind, 'error', 'nothing is left to stop');
});

for (const model of ['planner', 'coder', 'checker']) {
  test(`a text-only ${model} rejects images before starting any step`, async t => {
    const host = await setup(t, { info: async id => ({ inputModalities: id === model ? ['text'] : ['text', 'image'] }) });
    const reply = await host.run(`${options} do it`);
    assert.equal(reply.kind, 'error');
    assert.match(reply.text!, new RegExp(model));
    await delay(10);
    assert.equal(host.calls.length, 0);
  });
}

test('files without images work with text-only models', async t => {
  const host = await setup(t, { info: async () => ({ inputModalities: ['text'] }) });
  assert.equal((await host.run(`${options} do it`, [attachments[1]])).kind, 'success');
  await host.finished();
  assert.equal(host.calls.length, 3);
  assert.deepEqual(host.resolved, []);
  for (const call of host.calls) assert.deepEqual(call.request.prompt.slice(1), [attachments[1]]);
});

test('unknown model capabilities do not reject images', async t => {
  const host = await setup(t, { info: async () => { throw new Error('catalog unavailable'); } });
  assert.equal((await host.run(`${options} do it`)).kind, 'success');
  await host.finished();
  assertAttachments(host.calls);
});

for (const locale of ['en', 'zh']) {
  test(`attachments alone use the ${locale} default goal and show their count`, async t => {
    const host = await setup(t);
    await host.locale(locale);
    const goal = locale === 'zh' ? '按附件里的图片和文件的要求来做。' : 'Do what the attached images and files ask.';
    const reply = await host.run('');
    assert.equal(reply.kind, 'success');
    assert.ok(reply.text!.split('\n')[0].endsWith(locale === 'zh' ? '，2 个附件' : ', 2 attachments'));
    assert.equal(parseRow(reply.text!).body, goal);
    await host.finished();
    assert.match(host.calls[0].request.prompt[0].text!, new RegExp(goal));
    assertAttachments(host.calls);
  });
}

test('without attachments child prompts and the started row keep their original text', async t => {
  const host = await setup(t);
  const reply = await host.run(`${options} do it`, []);
  assert.deepEqual(parseRow(reply.text!), { title: 'Started: Plan planner → Implement coder → Review checker, up to 3 review rounds', body: 'do it', start: true });
  await host.finished();
  assert.deepEqual(host.calls.map(call => call.request.prompt), [
    [{ type: 'text', text: planPrompt('do it') }],
    [{ type: 'text', text: implementPrompt({ goal: 'do it', plan: 'planner output', round: 1 }) }],
    [{ type: 'text', text: reviewPrompt({ goal: 'do it', plan: 'planner output', round: 1, summary: 'coder output' }) }],
  ]);
  assert.deepEqual(host.resolved, []);
});

test('a finished flow is one card with every step, its results and the report', async t => {
  const host = await setup(t, { verdicts: ['fix it\nFLOW_VERDICT: needs_revision', 'all good\nFLOW_VERDICT: pass'] });
  await host.run(`${options} do it`, []);
  await host.finished();
  assert.equal(host.notes.length, 1, 'the flow adds one row, its card');
  const row = parseRow(host.notes[0]);
  assert.match(row.title, /^Done: review passed in round 2/);
  assert.match(row.body!, /coder output[\s\S]*all good/);
  assert.deepEqual(row.card!.steps.map(step => `${step.role}${step.round} ${step.model} ${step.status} ${step.body}`), [
    'plan0 planner done planner output', 'implement1 coder done coder output', 'review1 checker sentBack fix it',
    'implement2 coder done coder output', 'review2 checker passed all good',
  ]);
  assert.deepEqual(row.card!.steps.map(step => step.childId), host.calls.map(call => call.childId), 'each step opens its own conversation');
  assert.deepEqual({ ...row.card!.end!, ms: 0 }, { kind: 'passed', round: 2, sentBack: 1, ms: 0 });
  assert.equal(row.card!.planned, true);
  assert.deepEqual(row.card!.steps.map(step => step.note), [undefined, undefined, 'fix it', undefined, undefined], 'only a sent-back step carries a note');
  assert.equal(row.card!.parentId, 'parent');
});

test('a running card sends its steps without results, which come one at a time', async t => {
  const host = await setup(t, { pending: true });
  await host.run(`${options} do it`, []);
  await until(() => host.calls.length === 1);
  const { card } = await host.post({ action: 'card', commandId: 'command-1' }) as { card: LiveCard };
  assert.deepEqual(card.steps.map(step => [step.role, step.status, step.childId, step.body]), [['plan', 'running', host.calls[0].childId, undefined]]);
  assert.equal(typeof card.elapsed, 'number');
  assert.deepEqual(await host.post({ action: 'stepBody', commandId: 'command-1', index: 0 }), { body: null });
  assert.deepEqual(await host.post({ action: 'card', commandId: 'no-such-row' }), {});
});

test('after a restart a running card shows the steps it got through, as stopped', async t => {
  const first = await setup(t, { pending: true });
  await first.run(`${options} do it`, []);
  await until(() => first.calls.length === 1);
  await until(async () => {
    try { return (JSON.parse(await readFile(join(first.home, 'storages', 'dsh-model-flow', 'cards.json'), 'utf8')) as Record<string, { steps: { childId?: string }[] }>)['command-1']?.steps[0]?.childId === first.calls[0].childId; }
    catch { return false; }
  });
  // The first DSH is never told to stop, as when it is killed.
  const again = await setup(t, { home: first.home });
  const { card } = await again.post({ action: 'card', commandId: 'command-1' }) as { card: LiveCard };
  assert.equal(card.interrupted, true);
  assert.deepEqual(card.steps.map(step => [step.role, step.status, step.childId]), [['plan', 'running', first.calls[0].childId]]);
  assert.deepEqual(await again.post({ action: 'stop', commandId: 'command-1' }), { stopped: false });
});

test('a typed /flow being handled is known as the line that starts a card', async t => {
  const host = await setup(t, { info: () => new Promise(() => {}) });
  void host.command.handler({ commandId: 'typed-1', agent, rawInput: `${options} do it`, attachments });
  await until(async () => (await host.post({ action: 'card', commandId: 'typed-1' }) as { start?: boolean }).start === true);
});

test('another plugin starts a flow through the service and learns how it ended', async t => {
  const host = await setup(t, { verdicts: ['fix it\nFLOW_VERDICT: needs_revision', 'fine\nFLOW_VERDICT: pass'] });
  assert.equal(host.service.version, 2);
  const run = await host.service.start(host.agent, { goal: 'fix the bug', rounds: 2, attachments, tag: 'autofix:1:manual:7' });
  // While it runs, the plugin can ask how far it is: what the card shows, under the name it gave the flow.
  const early = run.progress();
  assert.deepEqual([early.tag, early.rounds, early.planned, early.parentId, early.end], ['autofix:1:manual:7', 2, true, 'parent', undefined]);
  const result = await run.done;
  const late = run.progress();
  assert.deepEqual([late.end?.kind, late.steps.length, late.steps.every(step => step.body === undefined)], ['passed', 5, true]);
  assert.match(run.stepBody(1) ?? '', /coder output/);
  assert.equal(run.stepBody(9), undefined);
  assert.deepEqual({ kind: result.end.kind, round: result.end.kind === 'passed' && result.end.round }, { kind: 'passed', round: 2 });
  assert.deepEqual(result.steps.map(step => `${step.role} ${step.round} ${step.status}`), ['plan 0 done', 'implement 1 done', 'review 1 sentBack', 'implement 2 done', 'review 2 passed']);
  assert.match(result.report ?? '', /coder output/);
  assertAttachments(host.calls);
  // The conversation shows the same card a typed /flow gets, and the card keeps the name.
  await host.finished();
  assert.equal(parseRow(host.notes.find(note => /^Done:/u.test(note))!).card?.tag, 'autofix:1:manual:7');
  // A name that is not `<plugin>:<words>` is left out rather than refused.
  const plain = await host.service.start(host.agent, { goal: 'again', tag: 'no colon here' });
  assert.equal(plain.progress().tag, undefined);
  plain.stop();
});

test('a /flow that asks for a worktree of its own is handed to Autofix, with what its line chose', async t => {
  const filed: Record<string, unknown>[] = [];
  const autofix = { async file(input: Record<string, unknown>) { filed.push(input); return { kind: 'success' as const, text: 'F3 · add csv\n\n<!-- autofix-row {"key":"manual:3"} -->' }; } };
  const host = await setup(t, { services: { autofix } });
  const reply = await host.run('wt=on repo=web branch="release 1" impl=coder rounds=2 add csv export');
  assert.deepEqual(reply, { kind: 'success', text: 'F3 · add csv\n\n<!-- autofix-row {"key":"manual:3"} -->' }, 'the row is Autofix\'s');
  assert.deepEqual(filed.map(({ agent: _agent, ...rest }) => rest), [{ text: 'add csv export', attachments, kind: 'feature', repo: 'web', branch: 'release 1', models: { implement: 'coder' }, rounds: 2 }]);
  assert.equal(filed[0].agent, host.agent);
  assert.equal(host.calls.length, 0, 'no flow runs in this conversation');
  // Without the option the flow runs here, as before; where a worktree goes means nothing then.
  assert.match((await host.run('repo=web add csv', [])).text ?? '', /repo= and branch= say where a worktree is made/);
  assert.equal((await host.run(`${options} do it`)).kind, 'success');
  await host.finished();
  assert.equal(filed.length, 1);
});

test('the settings decide where a typed /flow runs, and the line can say otherwise', async t => {
  const filed: string[] = [];
  const autofix = { async file(input: { text: string }) { filed.push(input.text); return { kind: 'success' as const, text: 'handed over' }; } };
  const host = await setup(t, { services: { autofix }, config: { worktree: true } });
  assert.match((await host.run('', [])).text ?? '', /Runs in a worktree of its own\./);
  assert.equal((await host.run('add csv', [])).text, 'handed over');
  assert.deepEqual(filed, ['add csv']);
  assert.equal((await host.run('wt=off do it here')).kind, 'success');
  await host.finished();
  assert.deepEqual([filed.length, host.calls.length], [1, 3]);
  assert.match((await host.run('wt=maybe x', [])).text ?? '', /wt is on or off/);
  // Saving anything else on the settings page keeps the choice.
  const saved = await host.post({ action: 'save', config: { rounds: 4, worktree: true, implement: { provider: 'p', model: 'coder', label: 'coder' } } }) as { config: { worktree?: boolean; rounds: number } };
  assert.deepEqual([saved.config.worktree, saved.config.rounds], [true, 4]);
  const off = await host.post({ action: 'save', config: { rounds: 4 } }) as { config: { worktree?: boolean } };
  assert.equal(off.config.worktree, undefined);
});

test('without Autofix a worktree flow says what is missing and how to run here instead', async t => {
  const host = await setup(t, { services: { autofix: { version: 1 } } });
  const reply = await host.run('wt=on add csv', []);
  assert.equal(reply.kind, 'error');
  assert.match(reply.text ?? '', /runs through Autofix \(dsh-autofix 0\.1\.4 or newer\).*wt=off/);
  assert.match((await host.run('wt=on 加上导出', [])).text ?? '', /自动修复插件.*wt=off/);
  assert.equal(host.calls.length, 0);
});

test('the service refuses what /flow refuses, and its stop ends the flow', async t => {
  const host = await setup(t, { pending: true });
  await assert.rejects(host.service.start(host.agent, { goal: '  ' }), /needs a goal/);
  await assert.rejects(host.service.start(host.agent, { goal: 'x', rounds: 0 }), /rounds must be/);
  await assert.rejects(host.service.start(host.agent, { goal: 'x', models: { implement: 'nobody' } }));
  const run = await host.service.start(host.agent, { goal: 'fix the bug', models: { plan: 'off', implement: 'coder' } });
  await until(() => host.calls.length === 1);
  assert.equal(host.calls[0].label, 'flow · implement 1');
  await assert.rejects(host.service.start(host.agent, { goal: 'again' }), /already running/);
  run.stop();
  assert.equal((await run.done).end.kind, 'stopped');
  assert.equal(host.disposed(), 1);
});
