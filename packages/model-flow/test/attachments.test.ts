import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';
import { attachmentNote, implementPrompt, planPrompt, reviewPrompt } from '../src/prompts.js';

const attachments = [
  { type: 'image' as const, attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', width: 16, height: 16, bytes: 97, name: 'image.png' } },
  { type: 'file' as const, attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'goal.txt', bytes: 10 } },
];
type Block = { type: string; text?: string };
interface Invocation { commandId?: string; agent: typeof agent; rawInput: string; attachments?: readonly { type: 'image' | 'file' }[] }
interface Reply { kind: 'success' | 'error'; text?: string }
interface Command { input: { attachments?: boolean }; handler(input: Invocation): Promise<Reply> }
interface ActivationSpec { label: string; signal: AbortSignal; request: { prompt: Block[]; agentOptions: { model: string } } }
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
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'model-flow-attachments-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers: (() => void)[] = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose();
    await delay(10);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });
  const route = (model: string) => ({ provider: 'p', model, label: model });
  const directory = join(home, 'storages', 'dsh-model-flow');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'config.json'), JSON.stringify({ plan: route('planner'), implement: route('coder'), review: route('checker'), rounds: 3 }));
  let command!: Command, fetch!: (request: Request) => Promise<Response>, reviews = 0, disposed = 0, commands = 0;
  const calls: ActivationSpec[] = [], notes: string[] = [], resolved: string[] = [];
  const ctx = {
    connection: { fetch: { register(definition: { fetch: typeof fetch }) { fetch = definition.fetch; } } },
    effect(callback: () => (() => void)) { disposers.push(callback()); },
    on() {}, get() { return undefined; },
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
      list: () => ['spawn'],
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
    command, calls, notes, resolved, disposed: () => disposed,
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

test('the stop button on a running row ends its flow and nothing else', async t => {
  const host = await setup(t, { pending: true });
  await host.run(`${options} do it`, []);
  await until(() => host.calls.length === 1);
  // The first command the flow runs itself is the plan step's row.
  const row = 'command-1';
  await until(async () => !!(await host.post({ action: 'step', commandId: row }) as { step: unknown }).step);
  assert.deepEqual(await host.post({ action: 'stop', commandId: 'no-such-row' }), { stopped: false });
  assert.equal(host.calls[0].signal.aborted, false);
  assert.deepEqual(await host.post({ action: 'stop', commandId: row }), { stopped: true });
  assert.equal(host.calls[0].signal.aborted, true);
  assert.equal(host.disposed(), 1);
  await until(async () => !(await host.post({ action: 'step', commandId: row }) as { step: unknown }).step);
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
    assert.ok(reply.text!.endsWith(goal));
    await host.finished();
    assert.match(host.calls[0].request.prompt[0].text!, new RegExp(goal));
    assertAttachments(host.calls);
  });
}

test('without attachments child prompts and the started row keep their original text', async t => {
  const host = await setup(t);
  const reply = await host.run(`${options} do it`, []);
  assert.equal(reply.text, 'Started: Plan planner → Implement coder → Review checker, up to 3 review rounds\ndo it');
  await host.finished();
  assert.deepEqual(host.calls.map(call => call.request.prompt), [
    [{ type: 'text', text: planPrompt('do it') }],
    [{ type: 'text', text: implementPrompt({ goal: 'do it', plan: 'planner output', round: 1 }) }],
    [{ type: 'text', text: reviewPrompt({ goal: 'do it', plan: 'planner output', round: 1, summary: 'coder output' }) }],
  ]);
  assert.deepEqual(host.resolved, []);
});
