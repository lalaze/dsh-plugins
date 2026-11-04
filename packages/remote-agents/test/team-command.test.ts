import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createHandler } from '../src/http.js';
import { Store } from '../src/core/store.js';
import type { Provider } from '../src/core/domain.js';
import { CREATE_TOOL, installTeamCommand, runTeamCommand, TEAM_COMMAND, type CommandInvocation, type TeamCommandDeps, type Tools } from '../src/teams/command.js';
import { buildTeamPlan, teamNameOf, type Catalog } from '../src/teams/plan.js';
import { allPresets, BUILTIN_PRESETS, choosePreset, parseMemberSpec, parseTeamCommand, teamPresetInput, type TeamPreset } from '../src/teams/presets.js';
import { fixture, providers } from './fakes.js';

const catalog = (extra: Provider[] = []): Catalog => ({ projectId: 'host-1', hostLabel: 'Mac mini', providers: [...structuredClone(providers), ...extra] });
const claude: Provider = { id: 'claude', label: 'Claude Code', status: 'ready', models: [
  { id: 'claude-opus-4-5', label: 'Opus 4.5', thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', isDefault: true }, { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }], modes: [] };
const ids = allPresets([]).map(preset => preset.id);

test('a /team line names a preset, assigns CLIs to members, takes options and keeps the goal as typed', () => {
  const parsed = parseTeamCommand(' pair coder=codex/remote-model@high reviewer=claude --plan --name "Login fix"  修复  登录超时\n再跑测试', ids);
  assert.equal(parsed.preset, 'pair'); assert.equal(parsed.review, true); assert.equal(parsed.name, '"Login');
  assert.deepEqual([...parsed.members], [['coder', { cli: 'codex', model: 'remote-model', effort: 'high' }], ['reviewer', { cli: 'claude' }]]);
  assert.equal(parsed.goal, 'fix"  修复  登录超时\n再跑测试', 'the goal starts at the first word that is not an option and keeps its spacing');
  assert.deepEqual(parseTeamCommand('修复登录超时', ids), { members: new Map(), goal: '修复登录超时', review: false });
  assert.deepEqual(parseTeamCommand('coder=Codex Add tests', ids).members.get('coder'), { cli: 'codex' }, 'CLI names are matched without case');
  assert.deepEqual(parseTeamCommand('--name=hotfix coder=captain go', ids), { members: new Map([['coder', { captain: true }]]), goal: 'go', review: false, name: 'hotfix' });
  assert.equal(parseTeamCommand('pair', ids).goal, '', 'a preset without a goal');
  assert.equal(parseTeamCommand('solo solo first', ids).goal, 'solo first', 'only the first leading preset name is the preset');
  assert.throws(() => parseTeamCommand('--fast go', ids), /Unknown option --fast/);
  assert.throws(() => parseTeamCommand('--name', ids), /needs a team name/);
  assert.throws(() => parseTeamCommand('captain=codex go', ids), /captain is this conversation/);
  assert.throws(() => parseMemberSpec('vim'), /Unknown CLI "vim"/);
  assert.throws(() => parseMemberSpec('codex/'), /no model after \//);
  assert.throws(() => parseMemberSpec('codex@'), /no thinking level/);
  assert.deepEqual(parseMemberSpec('CODEX'), { cli: 'codex' });
});

test('without a preset name the first preset whose members cover the assignments is used', () => {
  const own: TeamPreset = { id: 'docs', members: [{ name: 'writer', cli: 'claude' }], tasks: [{ id: 'write', subject: '{goal}', assignee: 'writer' }] };
  const presets = allPresets([own]);
  assert.equal(choosePreset(parseTeamCommand('go', ids), presets).id, 'docs', 'the first saved preset is the default');
  assert.equal(choosePreset(parseTeamCommand('coder=codex go', ids), presets).id, 'solo');
  assert.equal(choosePreset(parseTeamCommand('reviewer=claude coder=codex go', ids), presets).id, 'pair');
  assert.equal(choosePreset(parseTeamCommand('pair go', ids), presets).id, 'pair');
  assert.throws(() => choosePreset(parseTeamCommand('tester=codex go', ids), presets), /No team preset has members named tester; presets: docs \(writer\); solo \(coder\); pair \(coder, reviewer\)/);
  assert.throws(() => choosePreset({ preset: 'nope', members: new Map(), goal: 'x', review: false }, presets), /Unknown team preset "nope"/);
  assert.equal(allPresets([{ ...own, id: 'pair' }]).filter(preset => preset.id === 'pair').length, 1, 'a saved preset replaces the built-in with its id');
});

test('members resolve to the workspace machine’s CLI models; the goal fills the task template', () => {
  const pair = BUILTIN_PRESETS.find(preset => preset.id === 'pair')!;
  const plan = buildTeamPlan({ preset: pair, overrides: new Map([['coder', { cli: 'codex', effort: 'High' }], ['reviewer', { cli: 'claude', model: 'opus' }]]), goal: 'Fix the login timeout', review: false, catalogs: [catalog([claude])] });
  assert.deepEqual(plan.arguments, { name: 'Fix the login timeout', description: 'Fix the login timeout', approval: 'automatic', plan: {
    members: [{ name: 'coder', role: 'implement', provider: 'remote-cli-codex', model: 'host-1/codex/remote-model', reasoning_effort: 'high' }, { name: 'reviewer', role: 'review', provider: 'remote-cli-claude', model: 'host-1/claude/claude-opus-4-5' }],
    tasks: [{ id: 'work', subject: 'Fix the login timeout', description: pair.tasks[0].description, assignee: 'coder', dependencies: [] }, { id: 'review', subject: 'Review: Fix the login timeout', description: pair.tasks[1].description, assignee: 'reviewer', dependencies: ['work'] }] } });
  assert.deepEqual(plan.summary, ['coder → Codex Remote model (high) on Mac mini', 'reviewer → Claude Code Opus 4.5 on Mac mini']);
  const preset: TeamPreset = { id: 'mixed', members: [{ name: 'coder', cli: 'claude' }, { name: 'thinker' }], tasks: [{ id: 'work', subject: 'Part of {goal}', assignee: 'coder' }] };
  const mixed = buildTeamPlan({ preset, overrides: new Map(), goal: 'X', name: 'named', review: true, catalogs: [catalog([claude])] });
  assert.deepEqual(mixed.arguments.plan.members, [{ name: 'coder', provider: 'remote-cli-claude', model: 'host-1/claude/claude-sonnet-4-5' }, { name: 'thinker' }], 'the default model, and a member without a CLI keeps the captain’s');
  assert.equal(mixed.arguments.approval, 'required'); assert.equal(mixed.arguments.name, 'named');
  assert.equal(mixed.summary[1], "thinker → the captain's model");
  const captain = buildTeamPlan({ preset, overrides: new Map([['coder', { captain: true }]]), goal: 'X', review: false, catalogs: [] });
  assert.deepEqual(captain.arguments.plan.members[0], { name: 'coder' }, 'coder=captain overrides the preset CLI, so no remote workspace is needed');
  assert.throws(() => buildTeamPlan({ preset, overrides: new Map(), goal: 'X', review: false, catalogs: [] }), /not in a remote workspace, so coder cannot use Claude Code/);
  assert.throws(() => buildTeamPlan({ preset, overrides: new Map(), goal: 'X', review: false, catalogs: [catalog()] }), /Claude Code is not available on Mac mini; enable it/);
  assert.throws(() => buildTeamPlan({ preset, overrides: new Map([['coder', { cli: 'claude', model: '4-5' }]]), goal: 'X', review: false, catalogs: [catalog([claude])] }), /Several Claude Code models match "4-5": claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5/);
  assert.throws(() => buildTeamPlan({ preset, overrides: new Map([['coder', { cli: 'claude', model: 'gpt' }]]), goal: 'X', review: false, catalogs: [catalog([claude])] }), /Claude Code has no model "gpt" on this machine; models: claude-opus-4-5/);
  assert.throws(() => buildTeamPlan({ preset, overrides: new Map([['coder', { cli: 'claude', model: 'haiku', effort: 'high' }]]), goal: 'X', review: false, catalogs: [catalog([claude])] }), /Haiku 4.5 has no thinking levels/);
  assert.throws(() => buildTeamPlan({ preset, overrides: new Map([['coder', { cli: 'claude', model: 'opus', effort: 'max' }]]), goal: 'X', review: false, catalogs: [catalog([claude])] }), /Opus 4.5 has no thinking level "max"; levels: low, high/);
  assert.throws(() => buildTeamPlan({ preset: { ...preset, tasks: [] }, overrides: new Map(), goal: 'X', review: false, catalogs: [catalog([claude])] }), /has no tasks/);
  assert.equal(teamNameOf('  Fix the login timeout that happens when the session cookie expires early  '), 'Fix the login timeout that happens when');
  assert.equal(teamNameOf('修复登录超时\n再跑测试'), '修复登录超时');
  assert.equal(teamNameOf('Add capitalize(text) to text.mjs (first letter upper-case, the rest unchanged)'), 'Add capitalize(text) to text.mjs', 'no dangling bracket after the cut');
  assert.equal(teamNameOf('x'.repeat(50)), 'x'.repeat(40)); assert.equal(teamNameOf(' \n '), 'team');
});

test('a saved preset is validated: names, CLIs, assignees, dependencies and cycles', () => {
  const valid = teamPresetInput({ id: 'Docs', label: ' Docs team ', members: [{ name: 'writer', cli: 'Claude Code', model: 'opus', effort: 'high', role: '' }, { name: 'reader' }],
    tasks: [{ id: 'write', subject: '{goal}', assignee: 'writer', dependencies: [] }, { id: 'check', subject: 'Check', assignee: 'reader', dependencies: ['write', 'write'], description: '' }] });
  assert.deepEqual(valid, { id: 'docs', label: 'Docs team', members: [{ name: 'writer', cli: 'claude', model: 'opus', effort: 'high' }, { name: 'reader' }],
    tasks: [{ id: 'write', subject: '{goal}', assignee: 'writer' }, { id: 'check', subject: 'Check', assignee: 'reader', dependencies: ['write'] }] });
  const base = { id: 'p', members: [{ name: 'a' }, { name: 'b' }], tasks: [{ id: 't1', subject: 's', assignee: 'a' }] };
  assert.throws(() => teamPresetInput({ ...base, id: 'Bad id' }), /1-32 lowercase letters/);
  assert.throws(() => teamPresetInput({ ...base, members: [] }), /at least one member/);
  assert.throws(() => teamPresetInput({ ...base, members: [{ name: 'a' }, { name: 'A' }] }), /names must be different/);
  assert.throws(() => teamPresetInput({ ...base, members: [{ name: 'captain' }] }), /cannot be named captain/);
  assert.throws(() => teamPresetInput({ ...base, members: [{ name: 'a', cli: 'vim' }] }), /Unknown CLI "vim" for member a/);
  assert.throws(() => teamPresetInput({ ...base, members: [{ name: 'a', model: 'opus' }] }), /names a model without a CLI/);
  assert.throws(() => teamPresetInput({ ...base, tasks: [{ id: 't1', subject: 's', assignee: 'zed' }] }), /assigned to "zed", who is not a member/);
  assert.throws(() => teamPresetInput({ ...base, tasks: [{ id: 't1', subject: 's', dependencies: ['t9'] }] }), /depends on unknown task "t9"/);
  assert.throws(() => teamPresetInput({ ...base, tasks: [{ id: 't1', subject: 's', dependencies: ['t1'] }] }), /depends on itself/);
  assert.throws(() => teamPresetInput({ ...base, tasks: [{ id: 't1', subject: 's', dependencies: ['t2'] }, { id: 't2', subject: 's', dependencies: ['t1'] }] }), /cycle through t1/);
  assert.throws(() => teamPresetInput({ ...base, tasks: [{ id: 't1', subject: '' }] }), /needs a subject/);
  assert.throws(() => teamPresetInput({ ...base, tasks: [{ id: 't1', subject: 's' }, { id: 't1', subject: 's' }] }), /Task ids must be different/);
});

function invocation(rawInput: string, cwd: string | undefined = '/Users/me/.dsh/remote-workspaces/mini/app'): CommandInvocation {
  return { agent: { id: 'session-captain', session: { header: { cwd } } as CommandInvocation['agent']['session'] }, rawInput, signal: new AbortController().signal };
}
function deps(presets: TeamPreset[] = [], hostIds = ['host-1']): TeamCommandDeps {
  return { presets: () => presets, placement: async cwd => cwd?.includes('remote-workspaces') ? { hostIds, cwd: '/srv/app' } : { hostIds: [] }, catalogs: ids => ids.includes('host-1') ? [catalog([claude])] : [] };
}
function registry(outcome: { isError: false; value: unknown } | { isError: true; error: { message: string; info?: { code: string } } } = { isError: false, value: {} }) {
  const calls: unknown[] = [];
  const tools: Tools = { get: name => name === CREATE_TOOL ? {} : undefined, execute: async input => { calls.push(input); return outcome; } };
  return { tools, calls };
}

test('/team creates the team through agent_teams_create for the conversation and starts it', async () => {
  const { tools, calls } = registry();
  const result = await runTeamCommand(tools, deps(), invocation(' coder=codex reviewer=claude/opus@low  Fix the login timeout'));
  assert.deepEqual(result, { kind: 'success', text: 'Team "Fix the login timeout" started (2 members, 2 tasks): coder → Codex Remote model on Mac mini; reviewer → Claude Code Opus 4.5 (low) on Mac mini. Members report to this conversation; open the team panel from the chat title.' });
  assert.equal(calls.length, 1);
  const call = calls[0] as { callId: string; name: string; agent: { id: string }; arguments: { approval: string; name: string; plan: { members: { model?: string }[]; tasks: unknown[] } }; signal: AbortSignal };
  assert.equal(call.name, CREATE_TOOL); assert.equal(call.agent.id, 'session-captain', 'the conversation is the captain'); assert.match(call.callId, /^team-[0-9a-f-]{36}$/);
  assert.equal(call.arguments.approval, 'automatic'); assert.deepEqual(call.arguments.plan.members.map(member => member.model), ['host-1/codex/remote-model', 'host-1/claude/claude-opus-4-5']);
  assert.ok(call.signal instanceof AbortSignal);
  const staged = await runTeamCommand(tools, deps(), invocation('--plan coder=codex Fix it'));
  assert.equal(staged.kind, 'success'); assert.match(staged.text!, /is staged for review \(1 member, 1 task\): coder → Codex Remote model on Mac mini\. Open the team panel/);
  assert.equal((calls[1] as { arguments: { approval: string } }).arguments.approval, 'required');
});

test('/team explains what is missing instead of starting: the goal, the plugin, the workspace machine, or AgentTeams’ own refusal', async () => {
  const { tools, calls } = registry();
  assert.deepEqual(await runTeamCommand(tools, deps(), invocation('pair')), { kind: 'error', text: 'Usage: /team [preset] [member=cli/model] [--plan] <goal>. Presets: solo (coder); pair (coder, reviewer)' });
  assert.deepEqual(await runTeamCommand(undefined, deps(), invocation('coder=codex go')), { kind: 'error', text: '/team needs the @nanmicoder/dsh-agent-teams plugin; install and enable it, then restart DSH' });
  assert.deepEqual(await runTeamCommand({ ...tools, get: () => undefined }, deps(), invocation('coder=codex go')), { kind: 'error', text: '/team needs the @nanmicoder/dsh-agent-teams plugin; install and enable it, then restart DSH' });
  const unknown = registry({ isError: true, error: { message: 'Unknown tool', info: { code: 'UNKNOWN_TOOL' } } });
  assert.match((await runTeamCommand({ execute: unknown.tools.execute }, deps(), invocation('coder=codex go'))).text!, /needs the @nanmicoder\/dsh-agent-teams plugin/);
  assert.deepEqual(await runTeamCommand(tools, deps(), invocation('coder=codex go', '/Users/me/local-project')), { kind: 'error', text: 'This conversation is not in a remote workspace, so coder cannot use Codex' });
  assert.deepEqual(await runTeamCommand(tools, deps([], ['host-2']), invocation('coder=codex go')), { kind: 'error', text: 'This conversation is not in a remote workspace, so coder cannot use Codex' }, 'a machine without a saved catalog');
  assert.deepEqual(await runTeamCommand(tools, deps(), invocation('coder=grok go')), { kind: 'error', text: 'Grok is not available on Mac mini; enable it in Settings → Remote agents and refresh models' });
  assert.deepEqual(await runTeamCommand(tools, deps(), invocation('tester=codex go')), { kind: 'error', text: 'No team preset has members named tester; presets: solo (coder); pair (coder, reviewer)' });
  assert.equal(calls.length, 0, 'nothing was created');
  const refused = registry({ isError: true, error: { message: 'you already lead team "x" (id x). Use agent_teams_status and continue the existing team.' } });
  assert.deepEqual(await runTeamCommand(refused.tools, deps(), invocation('coder=codex go')), { kind: 'error', text: 'you already lead team "x" (id x). Use agent_teams_status and continue the existing team.' });
  const local = await runTeamCommand(tools, deps(), invocation('coder=captain go', '/Users/me/local-project'));
  assert.equal(local.kind, 'success', 'members on the captain’s model need no remote workspace');
});

test('the command registers once the host offers slash commands and tools, and unregisters with the plugin', async () => {
  const ctx = new Context(), registered: { name: string; description: string; input?: { hint: string } }[] = [];
  let unregistered = 0;
  const commands = { register: (definition: { name: string; description: string; input?: { hint: string } }) => { registered.push(definition); return () => { unregistered++; }; } };
  const plugin = ctx.plugin({ name: 'team-command-fixture', apply: (ctx: Context) => installTeamCommand(ctx, deps()) });
  await plugin.await();
  assert.equal(registered.length, 0, 'waits for the command registry');
  const disposeCommands = ctx.provide('commands', commands), disposeTools = ctx.provide('tools', registry().tools);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(registered.map(definition => [definition.name, definition.input?.hint]), [[TEAM_COMMAND, '[preset] [member=cli/model] [--plan] <goal>']]);
  await plugin.dispose(); await disposeTools(); await disposeCommands();
  assert.equal(unregistered, 1);
});

test('team presets are saved in the registry and served, validated, by the settings API', async t => {
  const { service, store, path, hostId } = await fixture(t), handle = createHandler(service);
  await service.discoverHost(hostId);
  const post = (body: Record<string, unknown>) => handle(new Request('http://dsh.test/api/remote-agents', { method: 'POST', headers: { 'content-type': 'application/json', 'X-DSH-Remote-Agents': '1' }, body: JSON.stringify(body) }));
  const docs = { id: 'docs', members: [{ name: 'writer', cli: 'claude', model: 'opus' }], tasks: [{ id: 'write', subject: '{goal}', assignee: 'writer' }] };
  let response = await post({ action: 'saveTeamPreset', preset: docs });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.deepEqual(body.presets, [docs]); assert.deepEqual(body.builtin.map((preset: TeamPreset) => preset.id), ['solo', 'pair']);
  assert.deepEqual(body.hosts, [{ id: hostId, label: 'Build server', providers: [{ id: 'codex', label: 'Codex', models: [{ id: 'remote-model', label: 'Remote model', isDefault: true, thinkingOptions: [{ id: 'high', label: 'High' }] }] }] }], 'ready CLIs and their models for the editor');
  const qa = { id: 'qa', members: [{ name: 'tester', cli: 'codex' }], tasks: [{ id: 'test', subject: 'Test {goal}', assignee: 'tester' }] };
  body = await (await post({ action: 'saveTeamPreset', preset: qa })).json();
  assert.deepEqual(body.presets.map((preset: TeamPreset) => preset.id), ['docs', 'qa'], 'a new preset is appended');
  body = await (await post({ action: 'saveTeamPreset', preset: qa, first: true })).json();
  assert.deepEqual(body.presets.map((preset: TeamPreset) => preset.id), ['qa', 'docs'], 'first makes it the default');
  body = await (await post({ action: 'saveTeamPreset', preset: { ...docs, label: 'Docs' } })).json();
  assert.deepEqual(body.presets.map((preset: TeamPreset) => [preset.id, preset.label]), [['qa', undefined], ['docs', 'Docs']], 'an edit keeps the place');
  response = await post({ action: 'saveTeamPreset', preset: { ...docs, tasks: [{ id: 'write', subject: 's', assignee: 'nobody' }] } });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /assigned to "nobody"/);
  body = await (await post({ action: 'removeTeamPreset', presetId: 'qa' })).json();
  assert.deepEqual(body.presets.map((preset: TeamPreset) => preset.id), ['docs']);
  assert.equal((await post({ action: 'removeTeamPreset', presetId: 'QA!' })).status, 400);
  await store.flush();
  const reopened = new Store(path); await reopened.open();
  assert.deepEqual(reopened.teamPresets(), [{ ...docs, label: 'Docs' }], 'presets survive a restart');
  assert.deepEqual(await (await post({ action: 'teamPresets' })).json().then((value: { presets: TeamPreset[] }) => value.presets), [{ ...docs, label: 'Docs' }]);
});
