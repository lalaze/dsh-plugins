import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { isTeamPrompt, teamMemberNote, teamMemberOf } from '../src/chat/agent-teams.js';
import { accessOf } from '../src/core/dsh-host.js';
import { decidePermission, unattendedAnswer } from '../src/agents/tools.js';
import type { Permission } from '../src/core/domain.js';

const session = (header: Record<string, unknown>, events: unknown[] = []) =>
  ({ header, eventAt: (seq: number) => events[seq] }) as unknown as Session;
const descriptor = (label: string) => ({ type: 'subagent/descriptor', data: { label, mode: 'continuable' } });

test('AgentTeams members are recognized by their subagent descriptor only', () => {
  assert.deepEqual(teamMemberOf(session({ parentSession: 'captain' }, [descriptor('agent-teams:web:code-reviewer')])), { team: 'web', member: 'code-reviewer' });
  assert.equal(teamMemberOf(session({ parentSession: 'captain' }, [descriptor('worker')])), undefined, 'an ordinary subagent');
  assert.equal(teamMemberOf(session({}, [descriptor('agent-teams:web:coder')])), undefined, 'a main conversation');
  assert.equal(teamMemberOf(session({ parentSession: 'captain' }, [{ type: 'session/start' }])), undefined);
  assert.equal(teamMemberOf(undefined), undefined);
});

test('assignments in the current and the older AgentTeams message source are prompts; other plugins are not', () => {
  assert.equal(isTeamPrompt({ kind: 'agent-teams' }), true);
  assert.equal(isTeamPrompt({ kind: 'plugin', plugin: '@nanmicoder/dsh-agent-teams' }), true);
  assert.equal(isTeamPrompt({ kind: 'plugin', plugin: 'other' }), false);
  assert.equal(isTeamPrompt({ kind: 'runtime-context', form: 'snapshot' }), false);
  assert.equal(isTeamPrompt(undefined), false);
});

test('the member note names the team tools and mentions approvals only when nobody answers', () => {
  const note = teamMemberNote({ team: 'web', member: 'coder' }, false);
  assert.match(note, /dsh-agent-teams/); assert.match(note, /agent_teams_claim_task, agent_teams_update_task, agent_teams_send_message, agent_teams_status/);
  assert.doesNotMatch(note, /approval prompts/);
  assert.match(teamMemberNote({ team: 'web', member: 'coder' }, true), /Nobody can answer approval prompts/);
});

function host(state: { preset: string; sandbox?: string; approval?: string }) {
  const presets: Record<string, { sandbox: string; approval: string }> = { 'read-only': { sandbox: 'read-only', approval: 'ask' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } };
  const services: Record<string, unknown> = {
    permissionPresets: { current: () => state.preset, resolve: (name: string) => { if (!presets[name]) throw new Error('unknown preset'); return presets[name]; } },
    sessionProjections: { stateOf: () => ({ preset: null, sandbox: state.sandbox, approval: state.approval }) },
    approval: { config: { policy: 'ask' } },
  };
  return { get: (name: string) => services[name] } as unknown as Context;
}

test('a delegated subagent that never asks is unattended and its sandbox bounds the CLI; main conversations are unchanged', () => {
  const member = session({ parentSession: 'captain' });
  assert.deepEqual(accessOf(host({ preset: 'custom', sandbox: 'workspace-write', approval: 'never' }), member), { permission: 'workspace-write', unattended: true });
  assert.deepEqual(accessOf(host({ preset: 'custom', sandbox: 'read-only', approval: 'never' }), member), { permission: 'read-only', unattended: true });
  assert.deepEqual(accessOf(host({ preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' }), member), { permission: 'danger-full-access', unattended: true });
  assert.deepEqual(accessOf(host({ preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }), member), { permission: 'workspace-write', unattended: false }, 'a subagent someone answers');
  assert.deepEqual(accessOf(host({ preset: 'auto', sandbox: 'workspace-write', approval: 'never' }), member), { permission: 'auto', unattended: false }, 'Auto review keeps its reviewer');
  assert.deepEqual(accessOf(host({ preset: 'custom', sandbox: 'workspace-write', approval: 'never' }), session({})), { permission: undefined, unattended: false }, 'a custom main conversation keeps the CLI mode');
  assert.deepEqual(accessOf({ get: () => undefined } as unknown as Context, member), { permission: undefined, unattended: false }, 'without DSH permission services');
});

test('a denial keeps the turn going: Codex cancel is chosen only when it is the only way to deny', async () => {
  const permission = (actions: Permission['actions']) => ({ id: 'p', kind: 'tool', name: 'Bash', actions }) as Permission;
  const both = permission([{ id: 'accept', label: 'Allow once', behavior: 'allow' }, { id: 'cancel', label: 'Cancel', behavior: 'deny' }, { id: 'decline', label: 'Deny', behavior: 'deny' }]);
  assert.equal(unattendedAnswer(both).selectedActionId, 'decline');
  assert.equal(unattendedAnswer(both).behavior, 'deny');
  assert.equal(unattendedAnswer(permission([{ id: 'cancel', label: 'Cancel', behavior: 'deny' }])).selectedActionId, 'cancel');
  assert.equal(unattendedAnswer(permission(undefined)).selectedActionId, undefined);
  const rejected = await decidePermission({ approval: { request: async () => 'rejected' }, userQuestions: { ask: async () => ({}) } }, both, { callId: 'c', signal: AbortSignal.timeout(1000) }, AbortSignal.timeout(1000), 'Codex');
  assert.equal(rejected?.selectedActionId, 'decline', 'a user who denies one command does not end the CLI turn');
});

test('an unattended refusal tells a model how to go on with a shell command, and only with one', () => {
  const asked = (name: string) => unattendedAnswer({ id: 'p', kind: 'tool', name, input: {} } as Permission);
  assert.equal(asked('Bash').behavior, 'deny');
  assert.match(asked('Bash').message!, /Retry it as plain separate commands/);
  assert.match(asked('Bash').message!, /say in your reply what you could not run/, 'a retry that is refused too must not become a loop');
  assert.doesNotMatch(asked('Edit').message!, /Retry/, 'writing another way is no answer to a refused edit');
  assert.match(asked('Edit').message!, /report it as a blocker/);
});
