import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { apply, type ModelFlowService } from '../src/index.js';
import { machinesFor, misplaced, runsIn, settle, type CatalogModel, type Place, type Routes } from '../src/routes.js';

const remote = (machine: string, label: string, cli: string, model: string, name: string): CatalogModel => ({ provider: `remote-cli-${cli}`, providerName: cli, id: `${machine}/${cli}/${model}`, name: `${name} · ${label}` });
const catalog: CatalogModel[] = [
  remote('mini-id', 'mac-mini', 'claude', 'opus', 'Opus 5.5'),
  remote('mini-id', 'mac-mini', 'codex', 'gpt-sol', 'GPT Sol'),
  remote('code-id', 'code', 'codex', 'gpt-sol', 'GPT Sol'),
  { provider: 'workbuddy', providerName: 'WorkBuddy', id: 'deepseek-flash', name: 'Deepseek Flash' },
];
const route = (model: CatalogModel) => ({ provider: model.provider, model: model.id, label: model.name });
const [opusMini, solMini, solCode, flash] = catalog.map(route);
const saved = ['mini-id', 'code-id'];
const onCode: Place = { machines: ['code-id'], saved, name: 'code', local: false };
const onThisComputer: Place = { machines: [], saved, local: true };

test('a model is looked for on the workspace\'s machine, whatever model the conversation itself has', () => {
  assert.deepEqual(machinesFor(onCode, 'mini-id'), ['code-id']);
  assert.deepEqual(machinesFor({ ...onCode, machines: ['code-id', 'code-2'] }, 'code-2'), ['code-2', 'code-id']);
  assert.deepEqual(machinesFor(undefined, 'mini-id'), ['mini-id']);
  assert.equal(settle(solMini, catalog, ['code-id']).model, 'code-id/codex/gpt-sol');
  assert.equal(settle(solMini, catalog, ['code-id']).label, 'GPT Sol · code');
  assert.equal(settle(opusMini, catalog, ['code-id']).model, 'mini-id/claude/opus');
  assert.equal(settle(flash, catalog, ['code-id']), flash);
  assert.equal(settle(solMini, catalog, []), solMini);
  assert.equal(settle(solMini, catalog, [undefined]), solMini);
});

test('a remote CLI runs only in workspaces of its own machine; other models run anywhere', () => {
  assert.equal(runsIn(solCode, onCode), true);
  assert.equal(runsIn(opusMini, onCode), false);
  assert.equal(runsIn(flash, onCode), true);
  assert.equal(runsIn(opusMini, onThisComputer), false);
  assert.equal(runsIn(flash, onThisComputer), true);
  // A route of another kind than a saved machine's is left for Remote Agents to judge.
  assert.equal(runsIn({ ...opusMini, model: 'legacy-project/claude/opus' }, onCode), true);
});

test('the refusal names the models, their machine, the workspace\'s machine and what that machine has', () => {
  const routes: Routes = { plan: opusMini, implement: solCode, review: opusMini };
  assert.equal(misplaced({ implement: solCode, review: flash }, onCode, catalog, true), undefined);
  const zh = misplaced(routes, onCode, catalog, true)!;
  assert.match(zh, /^计划模型 Opus 5\.5（mac-mini）、审核模型 Opus 5\.5（mac-mini）不能在这个工作区里运行：工作区在 code 上，而 code 上没有这些模型。/u);
  assert.match(zh, /code 上有：GPT Sol。请在「设置 → 模型分工」里换一个。$/u);
  const en = misplaced({ plan: opusMini, implement: solCode, review: flash }, onCode, catalog, false)!;
  assert.match(en, /^The plan model Opus 5\.5 \(mac-mini\) cannot run in this workspace: the workspace is on code, and code does not have this model\./u);
  assert.match(en, /code has: GPT Sol\. Choose another in Settings → Model flow\.$/u);
  // A long list is cut, and a model without a machine in its name still reads as a sentence.
  const many = [...catalog, ...['a', 'b', 'c', 'd', 'e'].map(id => remote('code-id', 'code', 'codex', id, `GPT ${id}`))];
  assert.match(misplaced(routes, onCode, many, true)!, /code 上有：GPT Sol、GPT a、GPT b、GPT c、GPT d 等。/u);
  assert.match(misplaced(routes, onCode, many, false)!, /code has: GPT Sol, GPT a, GPT b, GPT c, GPT d and others\./u);
  assert.match(misplaced({ implement: { ...opusMini, label: 'Opus 5.5' }, review: flash }, onCode, catalog, true)!, /^实现模型 Opus 5\.5 不能在这个工作区里运行/u);
  assert.match(misplaced(routes, { machines: ['docker-id'], saved: [...saved, 'docker-id'], name: 'docker', local: false }, catalog, true)!, /docker 上还没有可用的远程 CLI 模型，请在「设置 → 模型分工」里换成不带机器名的模型。$/u);
  assert.match(misplaced(routes, onThisComputer, catalog, true)!, /工作区在运行 DSH 的这台电脑上/u);
  assert.match(misplaced(routes, { machines: [], saved, local: false }, catalog, false)!, /a machine that is not saved in Remote agents/u);
});

interface Spec { label: string; request: { agentOptions: { provider: string; model: string } } }
async function setup(t: TestContext, config: Record<string, unknown>, placement: { hostIds: string[]; cwd?: string } | 'none' | 'broken') {
  const home = await mkdtemp(join(tmpdir(), 'model-flow-place-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers: (() => void)[] = [], cards: Promise<unknown>[] = [];
  t.after(async () => {
    // A finished flow still saves its card after `done` settles.
    await Promise.allSettled(cards);
    for (const dispose of disposers.reverse()) dispose();
    await delay(20);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  await mkdir(join(home, 'storages', 'dsh-model-flow'), { recursive: true });
  await writeFile(join(home, 'storages', 'dsh-model-flow', 'config.json'), JSON.stringify({ ...config, rounds: 1 }));
  let service!: ModelFlowService, command!: { handler(input: Record<string, unknown>): Promise<{ kind: string; text?: string }> };
  const calls: Spec[] = [], asked: (string | undefined)[] = [];
  const services: Record<string, unknown> = {
    workingDirectory: { get: (session: { folder: string }) => session.folder },
    ...(placement === 'none' ? {} : { remoteAgentsMachines: {
      hosts: () => [{ id: 'mini-id', label: 'mac-mini' }, { id: 'code-id', label: 'code' }],
      async resolve(path: string | undefined) { asked.push(path); if (placement === 'broken') throw new Error('Cannot read a valid remote workspace binding'); return placement; },
    } }),
  };
  const ctx = {
    connection: { fetch: { register() {} } },
    effect(callback: () => (() => void)) { disposers.push(callback()); },
    on() {}, get(name: string) { return services[name]; },
    provide(name: string, value: ModelFlowService) { if (name === 'modelFlow') service = value; },
    commands: {
      register(definition: typeof command) { command = definition; return () => {}; },
      execute(agent: unknown, line: string) {
        const card = command.handler({ commandId: `card-${cards.length}`, agent, rawInput: line.slice('/flow '.length) });
        cards.push(card);
        return card;
      },
    },
    llm: {
      listProviders: () => [...new Set(catalog.map(model => model.provider))].map(id => ({ id, name: id })),
      listModels: async (provider: string) => catalog.filter(model => model.provider === provider),
      resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    },
    subagents: {
      list: () => ['spawn'],
      async startActivation(spec: Spec) {
        calls.push(spec);
        return { childId: `child-${calls.length}`, result: Promise.resolve({ output: [{ type: 'text', text: 'FLOW_VERDICT: pass' }], stopReason: 'completed' }), async dispose() {} };
      },
    },
  };
  await apply(ctx as unknown as Context);
  // The conversation's own model is on the Mac mini, or no remote CLI at all: neither says where the workspace is.
  const agent = { id: 'parent', provider: 'workbuddy', model: 'deepseek-flash', phase: { kind: 'idle', lastTurn: 1 }, session: { folder: '/home/.dsh/remote-workspaces/code/app', header: {}, append() {}, deriveMessages: () => [] } };
  return { service, calls, asked, agent, run: (rawInput: string) => command.handler({ agent, rawInput }) };
}

test('a flow in a workspace on another machine runs that machine\'s copy of the saved models', async t => {
  const host = await setup(t, { plan: solMini, implement: solMini, review: flash }, { hostIds: ['code-id'], cwd: '/root/app' });
  const result = await (await host.service.start(host.agent, { goal: 'fix it' })).done;
  assert.equal(result.end.kind, 'passed');
  assert.deepEqual(host.asked, ['/home/.dsh/remote-workspaces/code/app']);
  assert.deepEqual(host.calls.map(call => call.request.agentOptions.model), ['code-id/codex/gpt-sol', 'code-id/codex/gpt-sol', 'deepseek-flash']);
  assert.deepEqual(result.steps.map(step => step.machine), ['code', 'code', undefined]);
});

test('a model the workspace\'s machine does not have stops the flow before any step, saying which', async t => {
  const host = await setup(t, { plan: opusMini, implement: solMini, review: opusMini }, { hostIds: ['code-id'], cwd: '/root/app' });
  await assert.rejects(host.service.start(host.agent, { goal: '修一下日期选择器' }), /计划模型 Opus 5\.5（mac-mini）、审核模型 Opus 5\.5（mac-mini）不能在这个工作区里运行：工作区在 code 上/u);
  const typed = await host.run('fix the date picker');
  assert.equal(typed.kind, 'error');
  assert.match(typed.text!, /The plan model Opus 5\.5 \(mac-mini\), the review model Opus 5\.5 \(mac-mini\) cannot run in this workspace: the workspace is on code/u);
  // Named on the line, a model is taken from the workspace's machine too, and one it lacks is refused the same way.
  assert.match((await host.run('plan=off review=opus fix the date picker')).text!, /^The review model Opus 5\.5 \(mac-mini\) cannot run/u);
  assert.equal(host.calls.length, 0);
  const named = await host.service.start(host.agent, { goal: 'fix it', models: { plan: 'off', review: 'codex' } });
  assert.equal((await named.done).end.kind, 'passed');
  assert.deepEqual(host.calls.map(call => call.request.agentOptions.model), ['code-id/codex/gpt-sol', 'code-id/codex/gpt-sol']);
});

test('a remote CLI model is refused in a workspace on DSH\'s own computer', async t => {
  const host = await setup(t, { implement: flash, review: solMini }, { hostIds: [] });
  await assert.rejects(host.service.start(host.agent, { goal: 'fix it' }), /The review model GPT Sol \(mac-mini\) cannot run in this workspace: the workspace is on the computer DSH runs on/u);
  assert.equal(host.calls.length, 0);
});

test('without Remote Agents, or when it cannot tell where the workspace is, the saved models are used as they are', async t => {
  for (const placement of ['none', 'broken'] as const) {
    const host = await setup(t, { implement: solMini, review: opusMini }, placement);
    assert.equal((await (await host.service.start(host.agent, { goal: 'fix it' })).done).end.kind, 'passed');
    assert.deepEqual(host.calls.map(call => call.request.agentOptions.model), ['mini-id/codex/gpt-sol', 'mini-id/claude/opus']);
  }
});
