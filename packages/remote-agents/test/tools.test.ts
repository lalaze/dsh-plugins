import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { delegationTools, type ToolDefinition, type ToolHost, type WaitResult } from '../src/tools.js';
import type { Agent } from '../src/domain.js';
import { fixture } from './fakes.js';

type Approval = Parameters<ToolHost['approval']['request']>[0];
function dshHost(outcome: string | ((input: Approval) => string) = 'allowed-once', answers: Awaited<ReturnType<ToolHost['userQuestions']['ask']>> = {}) {
  const approvals: Approval[] = [], questions: Parameters<ToolHost['userQuestions']['ask']>[0][] = [];
  const host: ToolHost = {
    approval: { request: async input => { approvals.push(input); return typeof outcome === 'function' ? outcome(input) : outcome; } },
    userQuestions: { ask: async input => { questions.push(input); return answers; } },
  };
  return { host, approvals, questions };
}
const call = (signal = new AbortController().signal, agent: unknown = { id: 'dsh-agent' }) => ({ callId: 'call-1', agent, signal });
async function until(condition: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Condition not reached'); await pause(10); }
}
async function setup(t: TestContext, outcome?: Parameters<typeof dshHost>[0], answers?: Parameters<typeof dshHost>[1]) {
  const base = await fixture(t), dsh = dshHost(outcome, answers);
  const tools = delegationTools(dsh.host, base.service);
  const tool = (name: string) => tools.find(definition => definition.name === name)!;
  const run = async (name: string, args: Record<string, unknown>, exec = call()) => (await tool(name).execute(args, exec)) as WaitResult;
  return { ...base, ...dsh, tools, tool, run };
}
/** The next agent created in the fake remote starts running and finishes after `delay`. */
function scripted(remote: Awaited<ReturnType<typeof fixture>>['remote'], reply: string, setup?: (agent: Agent) => void, delay = 30) {
  remote.onCreate = agent => {
    agent.status = 'running'; agent.activeTurn = { turnId: 'turn-1', startedAt: null }; setup?.(agent);
    if (!setup) setTimeout(() => finish(agent, reply), delay);
  };
  const finish = (agent: Agent, text = reply) => { remote.append(agent.id, { type: 'assistant_message', text }); agent.status = 'idle'; agent.activeTurn = null; };
  return finish;
}
const SUPPORTED = new Set(['type', 'properties', 'required', 'items', 'description', 'enum', 'additionalProperties']);
function assertSubset(schema: Record<string, unknown>, path: string) {
  for (const key of Object.keys(schema)) assert.ok(SUPPORTED.has(key), `${path}: unsupported keyword ${key}`);
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const name of (schema.required ?? []) as string[]) assert.ok(name in properties, `${path}: required ${name} is undeclared`);
  for (const [name, child] of Object.entries(properties)) assertSubset(child, `${path}.${name}`);
  if (schema.items) assertSubset(schema.items as Record<string, unknown>, `${path}[]`);
}

test('delegation tools use only the schema subset the DSH tool registry enforces', async t => {
  const { tools } = await setup(t);
  assert.deepEqual(tools.map(tool => tool.name), ['remote_agent_list', 'remote_agent_providers', 'remote_agent_create', 'remote_agent_send', 'remote_agent_wait', 'remote_agent_stop']);
  for (const tool of tools as ToolDefinition[]) {
    assert.equal(tool.parameters.type, 'object'); assertSubset(tool.parameters, tool.name);
    assert.deepEqual(tool.output.schema, {}); assert.ok(tool.description.length > 40);
  }
});

test('create resolves names and defaults, waits for the turn, and returns the reply', async t => {
  const { run, remote, service, tool } = await setup(t);
  scripted(remote, 'All 42 tests pass.');
  const result = await run('remote_agent_create', { host: 'build server', cwd: '/srv/project', provider: 'Codex', prompt: 'Run the test suite and report failures.', title: 'Test run' });
  assert.equal(result.timedOut, false);
  const [agent] = result.agents;
  assert.equal(agent.status, 'idle'); assert.equal(agent.reply, 'All 42 tests pass.');
  assert.equal(agent.host, 'Build server'); assert.equal(agent.model, 'remote-model'); assert.equal(agent.mode, 'Remote CLI settings');
  const summary = await service.summary(agent.id);
  assert.equal(summary.delegated, true); assert.equal(summary.title, 'Test run'); assert.equal(summary.modeId, 'inherit');
  const text = tool('remote_agent_create').output.render({}, result)[0].text;
  assert.match(text, new RegExp(`Agent ${agent.id}`)); assert.match(text, /All 42 tests pass/);
  await assert.rejects(run('remote_agent_create', { host: 'nowhere', cwd: '/srv/project', provider: 'codex', prompt: 'x' }), /Unknown remote host "nowhere". Saved hosts: Build server/);
  await assert.rejects(run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'claude', prompt: 'x' }), /Claude Code is unavailable/);
  await assert.rejects(run('remote_agent_create', { host: 'build-box', cwd: 'relative/path', provider: 'codex', prompt: 'x' }), /absolute/);
});

test('starting a remote agent without per-action approval needs explicit DSH approval', async t => {
  let decision = 'rejected';
  const { run, remote, approvals } = await setup(t, () => decision);
  scripted(remote, 'done');
  await assert.rejects(run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Deploy', mode: 'full-access' }), /needs the user's approval \(rejected\)/);
  assert.equal(remote.creates, 0);
  assert.equal(approvals[0].toolName, 'remote_agent_create'); assert.equal(approvals[0].callId, 'call-1'); assert.match(approvals[0].reason!, /will not ask before running commands/);
  await assert.rejects(run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Deploy', mode: 'full-access' }, call(undefined, null)), /\(unavailable\)/);
  decision = 'allowed-once';
  const result = await run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Deploy', mode: 'Full access' });
  assert.equal(result.agents[0].mode, 'Full access'); assert.equal(remote.creates, 1);
});

test('remote permission requests become one-time DSH approvals while a call waits', async t => {
  const { run, remote, approvals } = await setup(t, 'allowed-once');
  const finish = scripted(remote, 'Checks finished.', agent => {
    agent.pendingPermissions = [{ id: 'approval-1', name: 'Bash', kind: 'tool', title: 'Run pnpm test', detail: { command: 'pnpm test' }, actions: [
      { id: 'always', label: 'Always allow', behavior: 'allow', scope: 'session' }, { id: 'once', label: 'Allow once', behavior: 'allow' }, { id: 'no', label: 'Deny', behavior: 'deny' }] }];
  });
  const running = run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Run checks' });
  await until(() => remote.answers.length === 1);
  assert.deepEqual(remote.answers[0].answer, { behavior: 'allow', selectedActionId: 'once' });
  assert.equal(approvals[0].toolName, 'Bash'); assert.equal(approvals[0].callId, 'call-1'); assert.match(approvals[0].reason!, /Remote agent "Run checks".*asks: Run pnpm test/);
  finish(remote.agents.values().next().value!);
  const result = await running;
  assert.equal(result.agents[0].reply, 'Checks finished.'); assert.equal(approvals.length, 1);
});

test('a rejected approval denies through the native deny action; a dismissed one stays in the panel', async t => {
  let decision = 'rejected';
  const { run, remote } = await setup(t, () => decision);
  const permission = { id: 'approval-1', name: 'Edit', kind: 'tool', actions: [{ id: 'yes', label: 'Allow', behavior: 'allow' as const }, { id: 'no', label: 'Deny', behavior: 'deny' as const }] };
  scripted(remote, '', agent => { agent.pendingPermissions = [structuredClone(permission)]; });
  const rejected = run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Edit files' });
  await until(() => remote.answers.length === 1);
  assert.deepEqual(remote.answers[0].answer, { behavior: 'deny', message: 'The user denied this request', selectedActionId: 'no' });
  const first = [...remote.agents.values()][0]; first.status = 'idle'; first.activeTurn = null;
  await rejected;
  decision = 'cancelled';
  const result = await run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Edit more files' });
  assert.equal(result.agents[0].status, 'attention'); assert.deepEqual(result.agents[0].waitingFor, ['Edit']);
  assert.equal(remote.answers.length, 1, 'a dismissed prompt is never answered on the user’s behalf');
  assert.match(result.agents[0].reply ?? '', /^$/);
});

test('remote questions are asked through DSH user questions', async t => {
  const { run, remote, questions } = await setup(t, 'allowed-once', { answers: [{ id: 'Framework', selected: ['React'], custom: 'with Vite' }] });
  const finish = scripted(remote, 'Scaffolded.', agent => {
    agent.pendingPermissions = [{ id: 'question-1', name: 'AskUserQuestion', kind: 'question', input: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: true }] } }];
  });
  const running = run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Scaffold the app' });
  await until(() => remote.answers.length === 1);
  assert.equal(questions[0].questions[0].question, 'Which framework?'); assert.equal(questions[0].questions[0].multiSelect, true);
  assert.deepEqual(remote.answers[0].answer, { behavior: 'allow', answers: { Framework: 'React, with Vite' } });
  finish(remote.agents.values().next().value!);
  assert.equal((await running).agents[0].reply, 'Scaffolded.');
});

test('callers without a DSH agent get the pending request reported instead of a prompt', async t => {
  const { run, remote, approvals } = await setup(t);
  scripted(remote, '', agent => { agent.pendingPermissions = [{ id: 'approval-1', name: 'Bash', kind: 'tool' }]; });
  const result = await run('remote_agent_create', { host: 'build-box', cwd: '/srv/project', provider: 'codex', prompt: 'Run' }, call(undefined, null));
  assert.equal(result.agents[0].status, 'attention'); assert.deepEqual(result.agents[0].waitingFor, ['Bash']); assert.equal(approvals.length, 0);
});

test('send refuses to clobber a working agent unless asked to interrupt, and resolves ID prefixes', async t => {
  const { run, remote, service, request } = await setup(t);
  const agent = await service.create(request()), live = remote.live(agent.id);
  live.status = 'running'; live.activeTurn = { turnId: 'turn-1', startedAt: null };
  await assert.rejects(run('remote_agent_send', { agentId: agent.id.slice(0, 8), prompt: 'New instructions' }), /still working/);
  await assert.rejects(run('remote_agent_send', { agentId: agent.id.slice(0, 4), prompt: 'Too short' }), /Unknown remote agent/);
  assert.equal(remote.sends, 0);
  const result = await run('remote_agent_send', { agentId: agent.id.slice(0, 8), prompt: 'New instructions', interrupt: true });
  assert.equal(remote.interrupts, 1); assert.equal(result.agents[0].reply, 'Follow-up completed.');
});

test('waiting times out or aborts without stopping the remote agents', async t => {
  const { run, remote, service, request } = await setup(t);
  const agent = await service.create(request()); remote.live(agent.id).status = 'running';
  const result = await run('remote_agent_wait', { agentIds: [agent.id], timeoutSeconds: 1 });
  assert.equal(result.timedOut, true); assert.equal(result.agents[0].status, 'running'); assert.equal(remote.stops, 0);
  const controller = new AbortController(), waiting = run('remote_agent_wait', { agentIds: [agent.id] }, call(controller.signal));
  controller.abort();
  await assert.rejects(waiting, /abort/i);
  assert.equal(remote.stops, 0); assert.equal(remote.live(agent.id).status, 'running');
  const stopped = await run('remote_agent_stop', { agentId: agent.id });
  assert.equal(remote.stops, 1); assert.equal(stopped.agents[0].status, 'idle');
});

test('create without waiting fans out; wait collects several agents', async t => {
  const { run, remote } = await setup(t);
  const finishers: (() => void)[] = [];
  remote.onCreate = agent => { agent.status = 'running'; finishers.push(() => { remote.append(agent.id, { type: 'assistant_message', text: `done ${agent.id.slice(-4)}` }); agent.status = 'idle'; }); };
  const started = await Promise.all(['frontend', 'backend'].map(part => run('remote_agent_create', { host: 'build-box', cwd: `/srv/${part}`, provider: 'codex', prompt: `Review the ${part}`, wait: false })));
  assert.deepEqual(started.map(r => r.agents[0].status), ['running', 'running']);
  const waiting = run('remote_agent_wait', { agentIds: started.map(r => r.agents[0].id) });
  for (const finish of finishers) finish();
  const result = await waiting;
  assert.deepEqual(result.agents.map(a => a.status), ['idle', 'idle']); assert.ok(result.agents.every(a => a.reply?.startsWith('done')));
});

test('list reports hosts, recent projects and active agents; providers reports models and modes', async t => {
  const { tool, service, request } = await setup(t);
  const kept = await service.create(request()), archived = await service.create(request({ cwd: '/srv/old' }));
  await service.archive(archived.id);
  const list = await tool('remote_agent_list').execute({}, call()) as { projects: unknown[]; agents: { id: string }[] };
  assert.deepEqual(list.agents.map(a => a.id), [kept.id]); assert.deepEqual(list.projects, [{ host: 'Build server', cwd: '/srv/project' }]);
  const all = await tool('remote_agent_list').execute({ includeArchived: true }, call()) as { agents: { id: string; status: string }[] };
  assert.equal(all.agents.find(a => a.id === archived.id)!.status, 'archived');
  assert.match(tool('remote_agent_list').output.render({}, list)[0].text, /Build server \(ssh:\/\/builder@build-box/);
  const providers = await tool('remote_agent_providers').execute({ host: 'builder@build-box', cwd: '/srv/project' }, call());
  const text = tool('remote_agent_providers').output.render({}, providers)[0].text;
  assert.match(text, /codex \(Codex\): ready/); assert.match(text, /remote-model \[thinking: high\]/); assert.match(text, /inherit \(default\), ask, full-access/); assert.match(text, /claude \(Claude Code\): unavailable/);
});
